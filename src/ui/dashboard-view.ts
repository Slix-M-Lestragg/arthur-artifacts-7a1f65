/**
 * Arthur dashboard — desktop ItemView with THREE stacked elements (v0.6.1:
 * everything else — top summary bar, section headers, separate generation
 * panels + training table — removed or merged into these):
 *   0. SERVICE BAR — one pill button per agent service (src/ui/service-bar.ts):
 *                    click = start (inactive) / spawn (active), red kill zone
 *                    = stop ALL instances (confirm + force modals)
 *   0b. ERROR LINE — ONE slim banner directly under the service bar, listing
 *                    dead services + last error + attempted host:port; hidden
 *                    entirely while everything answers (also carries the
 *                    'not configured' / token / version-mismatch states).
 *   1. INSTANCES   — the GPU instance grid: one COLUMN per GPU (live stats
 *                    from GET /api/gpus, agent v0.5.2), one ROW per GPU-owning
 *                    instance (comfy, incl. multi-GPU spanning rows) and per
 *                    queued/running ai-toolkit training job. Rows are
 *                    self-contained outlined cards (running = accent tint,
 *                    idle = neutral, down = dashed muted + grayscale),
 *                    carrying a state badge (running/idle/down), quick run
 *                    stats for running rows (WS progress / job step+speed),
 *                    lifecycle buttons for instances, and a 'view in queue ↓'
 *                    link for running rows that scrolls to the matching
 *                    job-queue anchor below. Idle rows sort first, running
 *                    rows by run duration (longest first); run starts are
 *                    tracked locally (WS execution_start / queue transition;
 *                    agent uptime as fallback). /api/gpus unreachable →
 *                    columns derived from the instance gpus arrays (settings
 *                    fallback: 2) with a 'gpu stats unavailable' note; agent
 *                    fully down → grid hidden, the settings comfyPorts render
 *                    as unmanaged rows.
 *   2. JOB QUEUE   — ONE unified queue of compact job cards below the grid:
 *                    per comfy instance a group header (stable anchor id
 *                    arthur-queue-<port> for the grid links) holding the
 *                    queue depth + clear-queue/free-VRAM actions, followed by
 *                    the instance's running card (live WS progress + cancel)
 *                    and pending cards (per-prompt ✕ delete); ai-toolkit
 *                    training entries (arthur-training-row-<id> anchor) with
 *                    their existing action buttons + chart/log accordion;
 *                    per-GPU-set queue toggles close the queue. Ordering:
 *                    running (by run duration desc) → pending/queued →
 *                    recent stopped/error training (cap 5). Ports come from
 *                    the agent's discovered instances (settings list is the
 *                    fallback only).
 *
 * The DOM skeleton (service bar, error banner, grid, per-port queue groups)
 * is built once in onOpen; poll ticks and WS events only update text,
 * classes, attributes and bar widths, and re-append the cached queue nodes
 * in the sorted order described above. The instance rows, training cards,
 * pending prompt list and preview strip are refilled because their rows
 * legitimately appear and disappear (spawn/stop/run end) — everything else
 * is cached per port.
 *
 * Instance discovery (agent API v0.5.0): /api/status lists services with
 * computed instances; the queue groups + WS sockets attach to the
 * comfyui service's instance ports in agent order. The group set is rebuilt
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
import type { AgentGpu, AgentInstance, AgentService, AgentStatus } from "../api/agent";
import type { AiToolkitJob, AiToolkitJobStatus } from "../api/aitoolkit";
import type { ComfyUIClient, QueueResponse, SystemStats } from "../api/comfy";
import { parseComfyBinaryFrame } from "../comfy-frame";
import { WsConnection, WsState } from "../connection";
import { renderLossChart } from "./loss-chart";
import {
	el,
	DETAIL_INTERVAL_MS,
	fmtBytes,
	fmtDuration,
	fmtGigCompact,
	truncate,
} from "../util";
import { ArthurApiError, isTimeoutError } from "../api/transport";
import { ServiceBar } from "./service-bar";
import { confirmModal, describeError, run, toastErr, toastOk } from "./actions";

export const VIEW_TYPE_ARTHUR_DASHBOARD = "arthur-dashboard";

/** A section that shows neither data nor error for this long degrades to its
 *  error state (watchdog, independent of any hung request chain). */
const STUCK_AFTER_MS = 2 * DETAIL_INTERVAL_MS;
/** Watchdog cadence: finer than the stuck threshold, coarse enough to be cheap. */
const WATCHDOG_INTERVAL_MS = 1000;

/** Column count fallback when /api/gpus is unreachable AND no instance/jobs
 *  expose gpu placements (settings fallback: 2). */
const FALLBACK_GPU_COLUMNS = 2;
/** How long the grid's 'view in queue' target keeps the flash highlight. */
const FLASH_MS = 1500;

/** One GPU column of the instance grid. */
interface GridCol {
	index: number;
	/** Short display name (vendor/brand prefixes stripped). */
	name: string;
	usedMb: number | null;
	totalMb: number | null;
	util: number | null;
	tempC: number | null;
}

/** One sorted row of the instance grid (instance or training job). */
interface GridRowSpec {
	key: string;
	kind: "instance" | "training";
	title: string;
	gpus: number[];
	state: "running" | "idle" | "down";
	badge: string;
	meta: string;
	/** Run duration in seconds (running rows; sort input + display). */
	durationSec: number | null;
	/** Comfy quick stats (prompt id + live WS progress) — running instances. */
	prompt: { id: string | null; progress: GenProgress | null } | null;
	/** Training quick stats line — running/queued jobs. */
	statsText: string | null;
	/** Training step % for the micro progress bar (null → no bar). */
	statsPct: number | null;
	/** DOM anchor the 'view in queue' link points at. */
	anchor: string;
	// lifecycle wiring (instance rows only)
	svcId: string | null;
	instId: string | null;
	/** Instance port (instance rows only) — run tracking + panel lookup. */
	port: number | null;
}

/** Per-section stuck-state bookkeeping ("agent" / "training" / "gen:<port>"). */
interface SectionWatch {
	/** Timestamp of the tick that first left the section without a settle;
	 *  null once the section renders data OR an error. */
	pendingSinceMs: number | null;
	/** Degraded error state already painted (once per pending stretch). */
	degraded: boolean;
}

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

/** Cached DOM widgets + bookkeeping for one comfy port's queue group. */
interface GenPanel {
	port: number;
	// queue group header (anchor id arthur-queue-<port>): dot + label + ws
	// state + queue depth + clear-queue/free-VRAM actions
	head: HTMLElement;
	titleEl: HTMLElement;
	genDot: HTMLElement;
	wsDot: HTMLElement;
	wsLabel: HTMLElement;
	queueEl: HTMLElement;
	// running job card: live WS progress + cancel + preview strip
	runningCard: HTMLElement;
	runningTextEl: HTMLElement;
	progressFill: HTMLElement;
	progressLabel: HTMLElement;
	btnCancel: HTMLButtonElement;
	btnFree: HTMLButtonElement;
	btnClear: HTMLButtonElement;
	// pending job card (per-prompt ✕ delete rows)
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

/** One sort unit of the unified job queue (renderQueue). */
interface QueueEntry {
	rank: 0 | 1 | 2;
	/** Running entries: sort seconds (duration desc), else 0. */
	sort: number;
	/** Stable tie-break inside a rank (port/job order). */
	seq: number;
	nodes: HTMLElement[];
}

/** Never-throw wrapper for best-effort probes — keeps the error for diagnostics. */
async function tryCall<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: unknown }> {
	try {
		return { value: await fn(), error: null };
	} catch (err) {
		return { value: null, error: err };
	}
}

/** Short GPU display name — vendor/brand prefixes stripped. */
function gpuShortName(name: string): string {
	return String(name ?? "")
		.replace(/^NVIDIA\s+(GeForce\s+|Tesla\s+|Quadro\s+|Radeon\s+)/i, "")
		.trim() || "GPU";
}

/** Synthetic (stats-less) column for placements derived without /api/gpus. */
function syntheticCol(index: number): GridCol {
	return { index, name: `GPU ${index}`, usedMb: null, totalMb: null, util: null, tempC: null };
}

/** Parse an ai-toolkit gpu_ids string ("0" / "0,1") into usable indexes. */
function parseGpuIds(raw: string): number[] {
	return String(raw ?? "")
		.split(",")
		.map((part) => parseInt(part.trim(), 10))
		.filter((n) => Number.isFinite(n) && n >= 0);
}

/** Badge color class for a training job status. */
function jobBadgeCls(status: AiToolkitJobStatus): string {
	if (status === "running") return "arthur-badge--running";
	if (status === "error") return "arthur-badge--down";
	return "arthur-badge--idle";
}

/** Training step % for progress bars (null → no bar). */
function jobStepPct(job: AiToolkitJob): number | null {
	return job.total_steps != null && job.total_steps > 0 && job.step > 0
		? Math.min(100, Math.round((100 * job.step) / job.total_steps))
		: null;
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

	// cached element roots
	private serviceBarEl!: HTMLElement;
	private serviceBar!: ServiceBar;
	/** Slim error banner — hidden while every service answers (v0.6.1: the one
	 *  error surface, replacing the old top bar's errors/dots/profile line). */
	private bannerEl!: HTMLElement;
	/** Instance grid + its notes (replaced by unmanaged rows when agent down). */
	private gridEl!: HTMLElement;
	private gridNoteEl!: HTMLElement;
	private unmanagedEl!: HTMLElement;
	/** Unified job queue (comfy groups + training cards + aitk queue toggles). */
	private queueEl!: HTMLElement;
	/** Tail of the unified queue: per-GPU-set ai-toolkit queue toggles (shown
	 *  only while ai-toolkit answers) + the empty-queue note. */
	private aiQueueToggleEl!: HTMLElement;
	private queueEmptyEl!: HTMLElement;
	/** True while the training collector sits degraded (watchdog); cleared on
	 *  each settled tick — feeds the error banner. */
	private trainingStuck = false;

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
	/** Live GPU columns from GET /api/gpus (detail cycle). Empty list + error
	 *  = collector unreachable/degraded → grid falls back to derived columns. */
	private gpuDetail: { list: AgentGpu[]; error: string | null } = {
		list: [],
		error: null,
	};
	private lastTick: number | null = null;

	// stuck-state watchdog — no section waits past ~2 detail cycles
	private readonly sectionWatches = new Map<string, SectionWatch>();
	private watchTimer: number | null = null;

	/** Run-start tracking (local): WS execution_start / queue transition.
	 *  Keyed `run:<port>` (comfy) / `job:<id>` (training); agent uptime is the
	 *  fallback duration when no precise start is known. */
	private readonly runStarts = new Map<string, number>();
	/** Row keys seen in the previous build — distinguishes "already running at
	 *  view open" (uptime fallback) from a fresh idle→running transition. */
	private readonly runPrior = new Set<string>();
	/** Cached progress widgets of live grid rows, keyed like runStarts —
	 *  WS ticks repaint them without a grid rebuild. */
	private readonly gridRows = new Map<
		string,
		{ progressFill: HTMLElement; progressLabel: HTMLElement }
	>();
	/** Latest per-row run durations from buildGridRows ("inst:<id>" / "job:<id>")
	 *  — the unified queue's duration sort reuses them so the run-start
	 *  bookkeeping runs exactly once per tick. */
	private readonly gridRowDurations = new Map<string, number | null>();

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
	 * discovered LIVE instances (agent order) when /api/status answers — the
	 * settings comfyPorts list (labeled unmanaged) only when it doesn't.
	 * Down instances (up:false, port dead) never get a generation panel or a
	 * WS socket — they render as compact rows in the lifecycle section, where
	 * their start button lives (probing a dead port yields only timeout noise).
	 */
	private desiredPorts(): DesiredPort[] {
		const comfy = this.agentDetail.status?.services.find((s) => s.id === "comfyui");
		if (this.agentDetail.statusOk === true && comfy) {
			return comfy.instances
				.filter((i) => i.up === true)
				.map((i) => ({
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
		this.sectionWatches.clear();
		this.clearRunTracking();
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
		// Stuck-state watchdog: independent of the poll chain, it degrades any
		// section that sits neither in data nor in error for 2 detail cycles.
		if (this.watchTimer === null) {
			this.watchTimer = window.setInterval(
				() => this.checkStuckSections(),
				WATCHDOG_INTERVAL_MS,
			);
		}
		// Immediate first fill after the synchronously rendered skeleton: without
		// this, the user's first paint of data waits for the next 3s detail tick
		// (and the gate below no-ops that tick if layout isn't finished yet).
		void this.refreshData();
	}

	async onClose(): Promise<void> {
		this.isOpened = false;
		if (this.watchTimer !== null) {
			window.clearInterval(this.watchTimer);
			this.watchTimer = null;
		}
		this.sectionWatches.clear();
		this.closeWss();
		this.clearAllPreviews();
		this.clearTrainingState();
		this.clearRunTracking();
		if (this.plugin.dashboardView === this) this.plugin.dashboardView = null;
		this.contentEl.empty();
	}

	/** Mark a section as pending with no data/error yet (first tick only). */
	private watchPending(key: string): void {
		const w = this.sectionWatches.get(key);
		if (w && (w.pendingSinceMs !== null || w.degraded)) return;
		this.sectionWatches.set(key, { pendingSinceMs: Date.now(), degraded: false });
	}

	/** The section now renders data or an error — clear pending + degraded. */
	private watchSettle(key: string): void {
		const w = this.sectionWatches.get(key);
		if (w) {
			w.pendingSinceMs = null;
			w.degraded = false;
		}
	}

	/** Drop watches of generation ports that are no longer desired. */
	private pruneSectionWatches(): void {
		const wanted = new Set(this.activePorts.map((p) => `gen:${p.port}`));
		for (const key of this.sectionWatches.keys()) {
			if (key.startsWith("gen:") && !wanted.has(key)) this.sectionWatches.delete(key);
		}
	}

	/** Watchdog callback — degrade sections stuck between data and error. */
	private checkStuckSections(): void {
		if (!this.visible()) return;
		const now = Date.now();
		for (const [key, w] of this.sectionWatches) {
			if (w.pendingSinceMs === null || w.degraded) continue;
			if (now - w.pendingSinceMs < STUCK_AFTER_MS) continue;
			// No data, no error for ~2 detail cycles — the collector chain may be
			// wedged. Paint the error state NOW instead of waiting (possibly
			// forever) for the tick that may never settle.
			w.degraded = true;
			this.paintStuckSection(key);
		}
	}

	/** Paint a section's degraded 'no response — timeout/offline' state.
	 *  Runs outside the poll chain; the next settled tick repaints the truth. */
	private paintStuckSection(key: string): void {
		const host = this.plugin.clients?.profile.host ?? "";
		const mark = "no response — timeout/offline";
		if (key === "agent") {
			const port = this.plugin.clients?.profile.agentPort ?? 0;
			const hostPort = host ? `${host}:${port}` : "(not configured)";
			this.gridEl.hide();
			this.gridNoteEl.empty();
			this.gridNoteEl.append(
				el("p", {
					cls: "arthur-note",
					text: `arthur-agent — ${mark}`,
					attrs: { title: errTooltip(hostPort, mark) },
				}),
			);
			this.gridNoteEl.show();
		} else if (key === "training") {
			// No dedicated training element anymore — the error banner carries the
			// degraded state (the queue keeps painting the last known jobs).
			this.trainingStuck = true;
			this.renderBanner();
		} else if (key.startsWith("gen:")) {
			const port = Number(key.slice(4));
			const hostPort = host ? `${host}:${port}` : "(not configured)";
			const tooltip = errTooltip(hostPort, mark);
			const panel = this.panels.get(port);
			if (panel) {
				setDot(panel.genDot, false);
				panel.genDot.setAttribute("title", tooltip);
				panel.queueEl.setText(mark);
			}
		}
	}

	/** Per-service outcome label for one request error (debug breadcrumbs). */
	private outcomeFor(err: unknown): string {
		if (err == null) return "ok";
		return isTimeoutError(err) ? "timeout" : "err";
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
			this.gpuDetail = { list: [], error: null };
			this.lastTick = null;
			// The "not configured" placeholder is a settled state — no watch pending.
			this.sectionWatches.clear();
			this.trainingStuck = false;
			// Port set may have changed in settings while the view sat open.
			this.syncSkeleton();
			this.renderBanner();
			this.renderServiceBar();
			this.renderInstances();
			this.renderQueue();
			return;
		}

		// Stuck-state bookkeeping: every section in this tick starts pending;
		// the watchdog degrades any that never settles into data or error.
		const tickStarted = Date.now();
		this.watchPending("agent");
		this.watchPending("training");
		for (const p of this.desiredPorts()) this.watchPending(`gen:${p.port}`);

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
		// Health/status settled — with data (ok) or a captured error; both are
		// renderable states, so the agent section can never sit "loading" here.
		this.watchSettle("agent");
		const agentError = this.agentDetail.error;

		// Live GPU stats (detail cycle refresh for the grid columns + header
		// stats). Degradable by design: nvidia-smi failure → {gpus: [], error};
		// a request failure → empty list + the transport error. Both surface as
		// the grid's 'gpu stats unavailable' note + topbar errors entry.
		let gpuFetchError: unknown = null;
		this.gpuDetail = { list: [], error: null };
		if (healthOk) {
			const gRes = await tryCall(() => clients.agent.gpus());
			if (gRes.value !== null) {
				const list = gRes.value.gpus ?? [];
				this.gpuDetail = {
					list,
					error: list.length === 0 ? (gRes.value.error ?? "no gpus reported") : null,
				};
			} else {
				gpuFetchError = gRes.error;
				this.gpuDetail = { list: [], error: describeError(gRes.error) };
			}
		}

		// Settings may have changed, or the agent discovered/removed instances
		// (spawn/stop) — resync the cached cards + WS sockets with the current
		// host/port set before fetching. Rebuild only, never per tick; when the
		// port set is unchanged the labels still follow each tick's discovery
		// (e.g. discovered ↔ unmanaged fallback flips without a card rebuild).
		this.syncSkeleton();
		const desired = this.desiredPorts();
		this.activePorts = desired;
		this.pruneSectionWatches();
		const stale =
			profile.host !== this.wsHost ||
			!this.skeletonBuilt ||
			desired.map((p) => p.port).join(",") !==
				this.activePorts.map((p) => p.port).join(",");
		if (stale) this.rebuildPortPanels(desired);

		// Inner promises never reject; per-port failures land in .error. Each
		// port settles its own watch as soon as its result is known — one hung
		// port timeouts (8s) without blocking the others' settle bookkeeping.
		const comfyErrors = new Map<number, unknown>();
		this.comfyDetail = await Promise.all(
			desired.map(async ({ port }): Promise<ComfyPortDetail> => {
				const client = this.clientFor(port);
				if (!client) return { online: null, stats: null, queue: null, error: null };
				try {
					const stats = await client.systemStats();
					const queue = await client.queue();
					this.watchSettle(`gen:${port}`);
					return { online: true, stats, queue, error: null };
				} catch (err) {
					comfyErrors.set(port, err);
					this.watchSettle(`gen:${port}`);
					return {
						online: false,
						stats: null,
						queue: null,
						error: describeError(err),
					};
				}
			}),
		);

		const aiError: unknown = await (async () => {
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
				return null;
			} catch (err) {
				this.aiDetail = {
					reachable: false,
					jobs: [],
					queues: [],
					error: describeError(err),
				};
				return err;
			}
		})();
		// Jobs/queues settled — data or error, always a renderable state.
		this.watchSettle("training");

		this.lastTick = Date.now();
		this.trainingStuck = false;
		this.renderBanner();
		this.renderServiceBar();
		this.renderInstances();
		this.renderQueue();

		// Debug breadcrumb (settings toggle): one line per tick — collector
		// name, per-service outcome (ok/err/timeout), duration, host:port.
		if (this.plugin.settings.debugLogging) {
			const hostPort = (port: number) => `${profile.host}:${port}`;
			const parts: string[] = [];
			parts.push(
				`agent ${this.outcomeFor(health.value === null ? health.error : null)} ${hostPort(profile.agentPort)}` +
					(agentError ? ` · status ${this.outcomeFor(statusRes.error)}` : ""),
			);
			for (const p of desired) {
				parts.push(`comfy ${this.outcomeFor(comfyErrors.get(p.port) ?? null)} ${hostPort(p.port)}`);
			}
			parts.push(`aitk ${this.outcomeFor(aiError)} ${hostPort(profile.aiToolkitPort)}`);
			parts.push(`gpus ${this.outcomeFor(gpuFetchError)} ${hostPort(profile.agentPort)}`);
			console.debug(
				`arthur dashboard-detail ok ${Date.now() - tickStarted}ms · ${parts.join(" · ")}`,
			);
		}
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
		const root = this.contentEl.createEl("div", { cls: "arthur-dashboard" });

		// service pill row — top surface for service-level lifecycle
		this.serviceBarEl = root.createEl("div", { cls: "arthur-service-bar" });
		this.serviceBar = new ServiceBar(this.serviceBarEl, {
			onStart: (svc) => void this.serviceStartAction(svc),
			onSpawn: (svc) => void this.serviceSpawnAction(svc),
			onKill: (svc) => this.serviceKillAction(svc),
		});

		// ONE slim error banner under the service bar — dead services + last
		// error + attempted host:port; hidden entirely while all healthy. Also
		// carries the 'not configured' / token / version-mismatch states.
		this.bannerEl = root.createEl("div", { cls: "arthur-banner" });
		this.bannerEl.hide();

		// instance grid (no section header — the cards are self-describing):
		// one column per GPU, one card row per instance/training job; below it
		// the unmanaged-row fallback container (only rendered while the agent
		// is unreachable)
		this.gridEl = root.createEl("div", { cls: "arthur-grid" });
		this.gridEl.append(el("p", { cls: "arthur-note", text: "loading…" }));
		this.gridNoteEl = root.createEl("p", {
			cls: "arthur-note",
			text: "",
		});
		this.gridNoteEl.hide();
		this.unmanagedEl = root.createEl("div", { cls: "arthur-cards" });
		this.unmanagedEl.hide();

		// ONE unified job queue: per-port cached group (header + running card +
		// pending card) ordered per tick by the queue sorting rules, training
		// job cards rebuilt per tick. Re-attaching the cached nodes preserves
		// the WS-facing widget refs (progress bars never need a rebuild).
		this.queueEl = root.createEl("div", { cls: "arthur-queue" });
		for (const p of ports) {
			this.queueEl.append(this.buildGenGroup(p));
		}
		// Queue tail: per-GPU-set queue toggles (repainted per tick; shown only
		// while ai-toolkit answers) and the empty-queue note.
		this.aiQueueToggleEl = this.queueEl.createEl("div", { cls: "arthur-aiqueue" });
		this.aiQueueToggleEl.hide();
		this.queueEmptyEl = el("p", {
			cls: "arthur-note",
			text: "no jobs — every queue is clear",
		});
		this.queueEmptyEl.hide();

		// Port list the groups+WS are now built for.
		this.activePorts = ports;
		this.skeletonBuilt = true;
	}

	/**
	 * Build the queue group for one port and cache its widgets: a group header
	 * (stable anchor id arthur-queue-<port>, queue depth + clear/free actions),
	 * a running job card (live WS progress + cancel + preview strip) and a
	 * pending card (per-prompt ✕ delete rows). The nodes are cached for the
	 * view's lifetime; per-tick renderQueue only repaints + reorders them.
	 */
	private buildGenGroup(p: DesiredPort): HTMLElement {
		const port = p.port;
		const buttonRow = (...btns: HTMLButtonElement[]) =>
			el("div", { cls: "arthur-btn-row", children: btns });

		// group header — also the scroll target of the grid's 'view in queue ↓'
		const head = el("div", {
			cls: "arthur-queue-head",
			attrs: { id: `arthur-queue-${port}` },
		});
		const titleEl = el("span", { cls: "arthur-queue-title", text: p.label });
		const genDot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		const wsDot = el("span", { cls: "arthur-dot arthur-dot--gray" });
		const wsLabel = el("span", { cls: "arthur-card-meta", text: "ws off" });
		const queueEl = el("span", { cls: "arthur-card-meta", text: "…" });
		const btnClear = newBtn("Clear queue");
		btnClear.addClass("arthur-btn--tiny");
		const btnFree = newBtn("Free VRAM");
		btnFree.addClass("arthur-btn--tiny");
		head.append(
			genDot,
			titleEl,
			wsDot,
			wsLabel,
			queueEl,
			buttonRow(btnClear, btnFree),
		);

		// running job card — the only place the live WS progress surfaces
		const progressFill = el("div", { cls: "arthur-bar-fill" });
		progressFill.style.width = "0%";
		const progressLabel = el("span", { cls: "arthur-card-meta", text: "idle" });
		const runningTextEl = el("span", { cls: "arthur-card-meta" });
		runningTextEl.hide();
		const previewStrip = el("div", { cls: "arthur-preview-strip" });
		previewStrip.hide();
		const btnCancel = newBtn("Cancel");
		btnCancel.addClass("arthur-btn--tiny");
		const runningCard = el("div", {
			cls: "arthur-queue-job arthur-queue-job--running",
		});
		runningCard.append(
			el("div", {
				cls: "arthur-card-head",
				children: [
					el("span", { cls: "arthur-badge arthur-badge--running", text: "running" }),
					runningTextEl,
					buttonRow(btnCancel),
				],
			}),
			el("div", { cls: "arthur-bar", children: [progressFill] }),
			progressLabel,
			previewStrip,
		);
		runningCard.hide();

		// pending card — one compact row per queued prompt, refilled per tick
		const pendingWrap = el("div", {
			cls: "arthur-pending-list arthur-queue-job arthur-queue-job--pending",
		});
		pendingWrap.hide();

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

		this.panels.set(port, {
			port,
			head,
			titleEl,
			genDot,
			wsDot,
			wsLabel,
			queueEl,
			runningCard,
			runningTextEl,
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
		return head;
	}

	// ------------------------------------------------------------------
	// rendering — the slim error banner (the ONE error surface; hidden
	// entirely while every service answers)
	// ------------------------------------------------------------------

	/**
	 * Slim error line directly under the service bar: every dead service from
	 * the last tick with its last error + attempted host:port (no token
	 * material), plus the configuration problems the old banner carried (not
	 * configured / token rejected / version mismatch) and the watchdog's
	 * stuck-collector states. Hidden entirely when all healthy.
	 */
	private renderBanner(): void {
		const clients = this.plugin.clients;
		const host = clients?.profile.host ?? "";
		if (!host) {
			this.bannerEl.setText(
				"arthur is not configured — set the server host in the plugin settings",
			);
			this.bannerEl.show();
			return;
		}
		const hostPort = (port: number) => `${host}:${port}`;
		const errors: string[] = [];
		const ad = this.agentDetail;
		if (ad.healthOk === false) {
			errors.push(
				`agent ${hostPort(clients?.profile.agentPort ?? 0)} — ${ad.error ?? "offline"} — instance lifecycle disabled`,
			);
		} else if (ad.statusOk === false) {
			errors.push("agent token rejected — check Agent token in settings");
		} else if (ad.status && ad.status.version !== AGENT_VERSION) {
			errors.push(`agent version mismatch: server ${ad.status.version}, expected ${AGENT_VERSION} — update server/`);
		}
		// Watchdog: the training collector wedged between data and error.
		if (this.trainingStuck) {
			errors.push(
				`ai-toolkit ${hostPort(clients?.profile.aiToolkitPort ?? 0)} — no response — timeout/offline`,
			);
		}
		// Dead-service lines, same format as the old top-bar errors line:
		// service + error + host:port attempted.
		this.activePorts.forEach((p, i) => {
			const d = this.comfyDetail[i];
			if (d?.online === false) errors.push(`ComfyUI ${hostPort(p.port)} — ${d.error ?? "not responding"}`);
		});
		if (this.aiDetail.reachable === false && this.aiDetail.error) {
			errors.push(`ai-toolkit ${hostPort(clients?.profile.aiToolkitPort ?? 0)} — ${this.aiDetail.error}`);
		}
		// /api/gpus collector failure only matters while the agent answers at all
		// (grid columns fall back to derived placements otherwise).
		if (this.gpuDetail.error && ad.statusOk === true) {
			errors.push(`gpu stats ${hostPort(clients?.profile.agentPort ?? 0)} — ${this.gpuDetail.error}`);
		}
		if (errors.length > 0) {
			this.bannerEl.setText(`errors: ${errors.join(" · ")}`);
			this.bannerEl.setAttribute("title", errors.join("\n"));
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

	// ------------------------------------------------------------------
	// instance grid — one column per GPU, rows per instance/training job
	// ------------------------------------------------------------------

	/** Sync the instances section: the grid while the agent answers, the
	 *  unmanaged-row fallback when it doesn't (grid hidden entirely). */
	private renderInstances(): void {
		this.gridRows.clear();
		const ad = this.agentDetail;
		if (ad.statusOk === true && ad.status) {
			this.gridEl.show();
			this.gridNoteEl.hide();
			this.unmanagedEl.hide();
			this.renderInstanceGrid();
			return;
		}

		// Agent unreachable / token rejected — the grid needs instance/placement
		// data it cannot get: hide it and render the settings port list as
		// unmanaged rows (HTTP state visible, no lifecycle controls).
		this.gridEl.hide();
		this.gridNoteEl.hide();
		const host = this.plugin.clients?.profile.host ?? "";
		const hostPort = (port: number) => (host ? `${host}:${port}` : "(not configured)");
		const reason = ad.healthOk === false ? "unreachable" : "token rejected";
		const container = this.unmanagedEl;
		container.show();
		container.empty();
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

	/** GPU columns: /api/gpus when available, else derived from the instance
	 *  gpus arrays + training gpu_ids; final fallback = 2 synthetic columns. */
	private gridColumns(): GridCol[] {
		const live = this.gpuDetail.list;
		if (live.length > 0) {
			return live.map((g) => ({
				index: g.index,
				name: gpuShortName(g.name),
				usedMb: g.mem_used_mb,
				totalMb: g.mem_total_mb,
				util: g.util_percent,
				tempC: g.temp_c,
			}));
		}
		const idx = new Set<number>();
		const status = this.agentDetail.statusOk === true ? this.agentDetail.status : null;
		for (const svc of status?.services ?? []) {
			for (const inst of svc.instances) {
				for (const g of inst.gpus ?? (inst.gpu != null ? [inst.gpu] : [])) {
					if (g >= 0) idx.add(g);
				}
			}
		}
		for (const job of this.aiDetail.jobs) {
			for (const g of parseGpuIds(job.gpu_ids)) idx.add(g);
		}
		if (idx.size === 0) {
			return Array.from({ length: FALLBACK_GPU_COLUMNS }, (_, i) => syntheticCol(i));
		}
		return [...idx].sort((a, b) => a - b).map(syntheticCol);
	}

	/** Sorted grid rows: idle/down first, running last ordered by run duration
	 *  (longest first). Run starts are tracked locally; the agent-reported
	 *  uptime is the fallback duration for runs observed mid-flight. */
	private buildGridRows(): GridRowSpec[] {
		const rows: GridRowSpec[] = [];
		this.gridRowDurations.clear();
		const status = this.agentDetail.statusOk === true ? this.agentDetail.status : null;
		const comfy = status?.services.find((s) => s.id === "comfyui") ?? null;

		/** Run bookkeeping for one row key: precise duration when the local
		 *  tracker holds a start (WS execution_start / observed transition),
		 *  else null — callers apply their fallback (agent uptime). */
		const runDuration = (key: string, running: boolean): number | null => {
			const previously = this.runPrior.has(key);
			this.runPrior.add(key);
			if (!running) {
				this.runStarts.delete(key);
				return null;
			}
			if (!this.runStarts.has(key) && previously) {
				// idle → running transition observed between builds — stamp it.
				this.runStarts.set(key, Date.now());
			}
			const start = this.runStarts.get(key);
			return start != null ? (Date.now() - start) / 1000 : null;
		};

		for (const inst of comfy?.instances ?? []) {
			// Non-GPU instances (e.g. the aitoolkit UI service) are not grid
			// rows — they live in the service bar.
			const gpuList = inst.gpus?.length ? inst.gpus : inst.gpu != null ? [inst.gpu] : [];
			if (gpuList.length === 0) continue;
			const idx = this.activePorts.findIndex((p) => p.port === inst.port);
			const detail = idx >= 0 ? this.comfyDetail[idx] ?? null : null;
			const runningCount =
				inst.up && Array.isArray(detail?.queue?.queue_running)
					? detail!.queue!.queue_running.length
					: 0;
			const running = runningCount > 0;
			const key = `run:${inst.port}`;
			const duration = runDuration(key, running);
			const effective = duration ?? (running ? (inst.uptime ?? null) : null);
			this.gridRowDurations.set(key, effective);
			const panel = this.panels.get(inst.port);
			rows.push({
				key: `inst:${inst.id}`,
				kind: "instance",
				title: inst.name ?? inst.id,
				gpus: gpuList,
				state: !inst.up ? "down" : running ? "running" : "idle",
				badge: !inst.up ? "down" : running ? "running" : "idle",
				meta: `:${inst.port} · GPU ${gpuList.join(",")}`,
				durationSec: effective,
				prompt: running
					? {
							id: panel?.runningPromptId ?? null,
							progress: panel?.progress ?? null,
						}
					: null,
				statsText: null,
				statsPct: null,
				anchor: `arthur-queue-${inst.port}`,
				svcId: inst.service,
				instId: inst.id,
				port: inst.port,
			});
		}

		// Training jobs (queued/running only) — placed in the column(s) of
		// their gpu_ids; the aitoolkit SERVICE itself is not a grid row.
		if (this.aiDetail.reachable === true) {
			for (const job of this.aiDetail.jobs) {
				if (job.status !== "running" && job.status !== "queued") continue;
				const gpus = parseGpuIds(job.gpu_ids);
				if (gpus.length === 0) continue;
				const running = job.status === "running";
				const key = `job:${job.id}`;
				const duration = runDuration(key, running);
				const pct = jobStepPct(job);
				this.gridRowDurations.set(key, duration);
				rows.push({
					key,
					kind: "training",
					title: truncate(job.name, 28),
					gpus,
					state: running ? "running" : "idle",
					badge: job.status,
					meta: `GPUs ${job.gpu_ids || "?"}`,
					durationSec: duration,
					prompt: null,
					statsText:
						`${job.step}/${job.total_steps ?? "?"} · ${job.speed_string || "—"}`,
					statsPct: pct,
					anchor: `arthur-training-row-${job.id}`,
					svcId: null,
					instId: null,
					port: null,
				});
			}
		}

		const rank = (r: GridRowSpec) => (r.state === "running" ? 1 : 0);
		rows.sort((a, b) => {
			const byRank = rank(a) - rank(b);
			if (byRank !== 0) return byRank;
			if (rank(a) === 1) {
				return (b.durationSec ?? 0) - (a.durationSec ?? 0);
			}
			return a.title.localeCompare(b.title);
		});
		return rows;
	}

	/** Paint the grid: column headers (live stats from /api/gpus) + row cells. */
	private renderInstanceGrid(): void {
		const cols = this.gridColumns();
		const rows = this.buildGridRows();
		const grid = this.gridEl;
		this.gridNoteEl.hide();
		grid.empty();
		grid.style.gridTemplateColumns = `repeat(${cols.length}, minmax(0, 1fr))`;

		// Column headers (grid row 1): name, VRAM used/total bar + text, util, temp.
		cols.forEach((col, i) => {
			const fill = el("div", { cls: "arthur-bar-fill" });
			fill.style.width = "0%";
			const parts: string[] = [];
			if (col.usedMb != null && col.totalMb != null && col.totalMb > 0) {
				fill.style.width = `${Math.min(100, Math.round((100 * col.usedMb) / col.totalMb))}%`;
				parts.push(`VRAM ${fmtGigCompact(col.usedMb)}/${fmtGigCompact(col.totalMb)}`);
			} else {
				parts.push("VRAM ?");
			}
			if (col.util != null) parts.push(`util ${Math.round(col.util)}%`);
			if (col.tempC != null) parts.push(`${Math.round(col.tempC)}°`);
			const head = el("div", { cls: "arthur-grid-colhead" });
			head.style.gridColumn = `${i + 1} / span 1`;
			head.style.gridRow = "1";
			head.append(
				el("span", { cls: "arthur-grid-gpu-name", text: col.name }),
				el("div", { cls: "arthur-bar", children: [fill] }),
				el("span", { cls: "arthur-card-meta", text: parts.join(" · ") }),
			);
			grid.append(head);
		});

		// 'gpu stats unavailable' note — the agent answers but its nvidia-smi
		// probe failed (or the collector timed out); columns are derived.
		if (this.gpuDetail.list.length === 0) {
			const host = this.plugin.clients?.profile.host ?? "";
			const agentPort = this.plugin.clients?.profile.agentPort ?? 0;
			this.gridNoteEl.setText(`gpu stats unavailable — ${this.gpuDetail.error ?? "no data"}`);
			this.gridNoteEl.setAttribute(
				"title",
				errTooltip(host ? `${host}:${agentPort}` : "(not configured)", this.gpuDetail.error),
			);
			this.gridNoteEl.show();
		}

		rows.forEach((spec, r) => grid.append(this.gridRowEl(spec, cols, r)));
	}

	/** One row cell, spanning its GPU column(s). */
	private gridRowEl(spec: GridRowSpec, cols: GridCol[], rowIdx: number): HTMLElement {
		// Placement: lowest matching column index + a span over the columns the
		// row's GPU list covers (multi-GPU rows visually bridge the columns).
		let colStart = -1;
		for (const g of spec.gpus) {
			const i = cols.findIndex((c) => c.index === g);
			if (i >= 0 && (colStart < 0 || i < colStart)) colStart = i;
		}
		if (colStart < 0) colStart = Math.max(0, cols.length - 1);
		const span = Math.min(
			cols.length - colStart,
			Math.max(1, spec.gpus.length),
		);

		const cell = el("div", {
			cls: `arthur-grid-row arthur-grid-row--${spec.state}`,
			attrs: { "data-row-key": spec.key },
		});
		cell.style.gridColumn = `${colStart + 1} / span ${span}`;
		cell.style.gridRow = `${rowIdx + 2}`;

		const dotCls =
			spec.state === "running"
				? "arthur-dot arthur-dot--green"
				: spec.state === "down"
					? "arthur-dot arthur-dot--red"
					: "arthur-dot arthur-dot--gray";
		const head = el("div", { cls: "arthur-grid-row-head" });
		head.append(
			el("span", { cls: dotCls }),
			el("span", { cls: "arthur-grid-title", text: spec.title }),
			el("span", { cls: "arthur-card-meta", text: spec.meta }),
			el("span", {
				cls: "arthur-grid-head-tail",
				children: [
					...(spec.state === "running" && spec.durationSec != null
						? [el("span", {
								cls: "arthur-card-meta arthur-grid-duration",
								text: `${fmtDuration(spec.durationSec)} run`,
								attrs: { "aria-label": "run duration" },
						  })]
						: []),
					el("span", { cls: `arthur-badge arthur-badge--${spec.state}`, text: spec.badge }),
				],
			}),
		);
		cell.append(head);

		if (spec.kind === "instance" && spec.svcId && spec.instId) {
			const buttons = this.gridLifecycleButtons(spec);
			buttons.addClass("arthur-grid-actions");
			cell.append(buttons);
		}

		// Quick stats + queue link for RUNNING rows.
		if (spec.state === "running") {
			if (spec.kind === "instance") {
				const progressFill = el("div", { cls: "arthur-bar-fill" });
				progressFill.style.width = "0%";
				const progressLabel = el("span", { cls: "arthur-card-meta", text: "…" });
				const p = spec.prompt;
				const promptLine = el("span", {
					cls: "arthur-card-meta",
					text: p?.id ? `prompt ${truncate(p.id, 12)}` : "running (prompt id unknown)",
				});
				cell.append(promptLine, el("div", { cls: "arthur-bar", children: [progressFill] }), progressLabel);
				this.gridRows.set(`run:${spec.port}`, { progressFill, progressLabel });
				const panel = spec.port != null ? this.panels.get(spec.port) : null;
				if (panel) this.paintProgress(panel.progress, progressFill, progressLabel);
			} else {
				const statsFill = el("div", { cls: "arthur-bar-fill" });
				statsFill.style.width = spec.statsPct != null ? `${spec.statsPct}%` : "0%";
				cell.append(
					el("span", { cls: "arthur-card-meta", text: spec.statsText ?? "" }),
					el("div", { cls: "arthur-bar", children: [statsFill] }),
				);
			}
			const link = el("a", {
				cls: "arthur-grid-link",
				text: "view in queue ↓",
				attrs: { href: `#${spec.anchor}` },
			});
			link.addEventListener("click", (e) => {
				e.preventDefault();
				this.flashAnchor(spec.anchor);
			});
			cell.append(link);
		}
		return cell;
	}

	/** Start/stop/restart for one grid instance row (down rows: start only) —
	 *  reuses the agent lifecycle handlers with the existing confirm/force
	 *  (409) escalation contract. */
	private gridLifecycleButtons(spec: GridRowSpec): HTMLElement {
		const instName = spec.title;
		const op = (action: "start" | "stop" | "restart") =>
			void this.instanceLifecycle(spec.svcId!, spec.instId!, `${action} ${instName}`, action);
		const btnStart = newBtn("Start");
		btnStart.addClass("arthur-btn--tiny");
		btnStart.addEventListener("click", () => op("start"));
		const buttons: HTMLButtonElement[] = [btnStart];
		if (spec.state !== "down") {
			const btnStop = newBtn("Stop");
			btnStop.addClass("arthur-btn--tiny");
			btnStop.addEventListener("click", () =>
				confirmModal(
					this.app,
					"Stop instance",
					`Gracefully stop ${instName} on port ${spec.port}? The agent refuses while a generation is running.`,
					() => op("stop"),
				),
			);
			const btnRestart = newBtn("Restart");
			btnRestart.addClass("arthur-btn--tiny");
			btnRestart.addEventListener("click", () =>
				confirmModal(
					this.app,
					"Restart instance",
					`Restart ${instName}? It is down until the port comes back up (~30s).`,
					() => op("restart"),
				),
			);
			buttons.push(btnStop, btnRestart);
		}
		return el("div", { cls: "arthur-btn-row", children: buttons });
	}

	/** Clear local run tracking (view close/reopen). */
	private clearRunTracking(): void {
		this.runStarts.clear();
		this.runPrior.clear();
		this.gridRows.clear();
		this.gridRowDurations.clear();
	}

	/** Scroll the job-queue anchor into view and flag it with the flash class. */
	private flashAnchor(anchorId: string): void {
		const target = this.findAnchor(anchorId);
		if (!target) return;
		if (typeof target.scrollIntoView === "function") {
			target.scrollIntoView({ behavior: "smooth", block: "start" });
		}
		target.addClass("arthur-flash");
		window.setTimeout(() => target.removeClass("arthur-flash"), FLASH_MS);
	}

	/**
	 * Anchor lookup: the native document lookup first, falling back to a walk
	 * of the view tree (minimal test-DOM stubs may not implement getElementById).
	 */
	private findAnchor(anchorId: string): HTMLElement | null {
		if (typeof document.getElementById === "function") {
			const hit = document.getElementById(anchorId);
			if (hit) return hit;
		}
		const walk = (node: unknown): HTMLElement | null => {
			const n = node as { attributes?: Map<string, string>; children?: unknown[] } | null;
			if (!n || typeof n !== "object") return null;
			if ((n.attributes as Map<string, string> | undefined)?.get("id") === anchorId) {
				return n as unknown as HTMLElement;
			}
			for (const child of n.children ?? []) {
				const hit = walk(child);
				if (hit) return hit;
			}
			return null;
		};
		return walk(this.contentEl);
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

	// ------------------------------------------------------------------
	// ONE unified job queue — per-port comfy groups (running + pending
	// cards) merged with ai-toolkit training cards, sorted:
	//   0. running (run duration desc, comfy before training on ties)
	//   1. pending/queued (comfy groups, then queued training jobs)
	//   2. recent stopped/error training jobs (newest first, cap 5)
	// Idle comfy instances still emit their group header (queue depth +
	// clear-queue/free-VRAM actions stay reachable); each port's header is
	// emitted once, directly above its first card in the sorted flow.
	// ------------------------------------------------------------------

	/** Cap on the ranked-2 "recent stopped/error" training tail. */
	private static readonly RECENT_TRAINING_CAP = 5;

	private runSortSeconds(key: string): number {
		return this.gridRowDurations.get(key) ?? 0;
	}

	/**
	 * Repaint + reorder the unified queue. Cached nodes (group headers,
	 * running cards, pending cards) are moved, not rebuilt — WS-facing
	 * progress widgets keep their identity; training cards rebuild per tick
	 * (their action rows depend on the job status).
	 */
	private renderQueue(): void {
		const q = this.queueEl;
		const host = this.plugin.clients?.profile.host ?? "";
		const entries: QueueEntry[] = [];
		const headEmitted = new Set<number>();
		const emitHead = (port: number, entry: QueueEntry): void => {
			const panel = this.panels.get(port);
			if (!panel || headEmitted.has(port)) return;
			headEmitted.add(port);
			panel.head.show();
			entry.nodes.push(panel.head);
		};

		// comfy groups — running card first (rank 0), then pending card (rank 1);
		// an idle instance still emits its header alone (rank 1) so the queue
		// depth + clear-queue/free-VRAM actions remain reachable.
		this.activePorts.forEach((p, i) => {
			const panel = this.panels.get(p.port);
			if (!panel) return;
			const counts = this.updateGenEntry(panel, p, this.comfyDetail[i] ?? null, host);
			if (counts.running > 0) {
				const entry: QueueEntry = {
					rank: 0,
					sort: this.runSortSeconds(`run:${p.port}`),
					seq: i,
					nodes: [],
				};
				emitHead(p.port, entry);
				panel.runningCard.show();
				entry.nodes.push(panel.runningCard);
				entries.push(entry);
			} else {
				panel.runningCard.hide();
			}
			if (counts.pending > 0) {
				const entry: QueueEntry = { rank: 1, sort: 0, seq: i, nodes: [] };
				emitHead(p.port, entry);
				panel.pendingWrap.show();
				entry.nodes.push(panel.pendingWrap);
				entries.push(entry);
			} else {
				panel.pendingWrap.hide();
			}
			if (counts.running + counts.pending === 0) {
				const entry: QueueEntry = { rank: 1, sort: 0, seq: i, nodes: [] };
				emitHead(p.port, entry);
				entries.push(entry);
			}
		});

		// ai-toolkit training cards — running (rank 0, duration-sorted),
		// queued/stopping (rank 1, queue position first), recent stopped/error
		// (rank 2, newest updated_at first, capped).
		if (this.aiDetail.reachable === true) {
			// Drop caches/state for jobs that no longer exist (deleted or job
			// list rebuilt) before the per-tick card rebuild.
			this.pruneTrainingState();
			this.jobPanelEls.clear();
			let queuedSeq = 0;
			let recentSeq = 0;
			for (const job of this.aiDetail.jobs) {
				if (job.status === "running") {
					entries.push({
						rank: 0,
						sort: this.runSortSeconds(`job:${job.id}`),
						seq: 100 + queuedSeq++,
						nodes: [this.jobQueueCard(job)],
					});
				} else if (job.status === "queued" || job.status === "stopping") {
					entries.push({
						rank: 1,
						sort: job.queue_position ?? 0,
						seq: 100 + queuedSeq++,
						nodes: [this.jobQueueCard(job)],
					});
				}
				// "completed" jobs are history, not queue entries — skipped.
			}
			const recentJobs = this.aiDetail.jobs
				.filter((j) => j.status === "stopped" || j.status === "error")
				.sort(
					(a, b) =>
						(Date.parse(b.updated_at ?? "") || 0) -
							(Date.parse(a.updated_at ?? "") || 0),
				)
				.slice(0, ArthurDashboardView.RECENT_TRAINING_CAP);
			for (const job of recentJobs) {
				entries.push({
					rank: 2,
					sort: 0,
					seq: recentSeq++,
					nodes: [this.jobQueueCard(job)],
				});
			}
			this.renderTrainingQueueToggles();
		} else {
			this.aiQueueToggleEl.hide();
		}

		// Rank order + running duration desc + stable tie-breaks.
		entries.sort(
			(a, b) =>
				a.rank - b.rank || b.sort - a.sort || a.seq - b.seq,
		);
		q.empty();
		for (const entry of entries) {
			for (const node of entry.nodes) q.append(node);
		}
		for (const panel of this.panels.values()) {
			if (!headEmitted.has(panel.port)) panel.head.hide();
		}
		if (entries.length === 0) this.queueEmptyEl.show();
		else this.queueEmptyEl.hide();
		this.queueEl.append(this.aiQueueToggleEl, this.queueEmptyEl);
	}

	private renderProgress(panel: GenPanel): void {
		this.paintProgress(panel.progress, panel.progressFill, panel.progressLabel);
	}

	/** Paint one (bar-fill, label) progress widget pair — shared by the port
	 *  panel and the live grid rows. */
	private paintProgress(p: GenProgress | null, fill: HTMLElement, label: HTMLElement): void {
		if (p && p.max > 0) {
			fill.style.width = `${Math.min(100, Math.round((100 * p.value) / p.max))}%`;
			label.setText(`${p.nodeLabel} ${p.value}/${p.max}`);
		} else {
			fill.style.width = "0%";
			label.setText("idle");
		}
	}

	/** WS tick → repaint the live grid row's progress widgets without a grid
	 *  rebuild (no-op when the port currently has no live grid row). */
	private updateGridProgress(port: number): void {
		const widgets = this.gridRows.get(`run:${port}`);
		if (!widgets) return;
		this.paintProgress(
			this.panels.get(port)?.progress ?? null,
			widgets.progressFill,
			widgets.progressLabel,
		);
	}

	/**
	 * Refresh one comfy port's cached queue widgets (header labels, dots,
	 * queue depth, pending rows, button enablement, progress bar) against the
	 * latest poll data, and report its running/pending counts as the sort
	 * input for the unified queue.
	 */
	private updateGenEntry(
		panel: GenPanel,
		p: DesiredPort,
		detail: ComfyPortDetail | null,
		host: string,
	): { running: number; pending: number } {
		const running = Array.isArray(detail?.queue?.queue_running)
			? (detail!.queue!.queue_running as unknown[])
			: [];
		const pending = Array.isArray(detail?.queue?.queue_pending)
			? (detail!.queue!.queue_pending as unknown[])
			: [];
		const online = detail?.online === true;

		panel.titleEl.setText(p.label);
		setDot(panel.genDot, detail?.online ?? null);
		panel.genDot.setAttribute(
			"title",
			detail?.online === false
				? errTooltip(host ? `${host}:${p.port}` : "(not configured)", detail.error)
				: `${p.label} — ${online ? "ok" : "waiting for data…"}`,
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
		if (running.length > 0) {
			panel.runningTextEl.setText(
				pid
					? `${truncate(pid, 12)} · ${classes.slice(0, 4).join(" → ")}${classes.length > 4 ? " → …" : ""}`
					: "running (prompt id unknown)",
			);
			panel.runningTextEl.show();
		} else {
			panel.runningTextEl.hide();
		}

		// pending list (refilled — rows come and go)
		panel.pendingIds = pending.flatMap((e) =>
			Array.isArray(e) && typeof e[1] === "string" ? [e[1] as string] : [],
		);
		panel.pendingWrap.empty();
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

		panel.btnCancel.disabled = !online || running.length === 0;
		panel.btnClear.disabled = !online || pending.length === 0;
		panel.btnFree.disabled = !online;

		this.renderProgress(panel);
		return { running: running.length, pending: pending.length };
	}

	/**
	 * Per-GPU-set ai-toolkit queue toggles — the tail of the unified queue,
	 * only rendered while ai-toolkit answers (elsewhere hidden; the error
	 * banner carries the unreachable state).
	 */
	private renderTrainingQueueToggles(): void {
		const wrap = this.aiQueueToggleEl;
		wrap.show();
		wrap.empty();
		if (this.aiDetail.queues.length === 0) {
			wrap.append(el("span", { cls: "arthur-card-meta", text: "no ai-toolkit queues" }));
			return;
		}
		for (const q of this.aiDetail.queues) wrap.append(this.queueRow(q));
	}

	/**
	 * One training job card of the unified queue (stable anchor id
	 * arthur-training-row-<id>): status badge + name + GPUs + step/speed
	 * stats, step progress bar while running, the existing action buttons,
	 * and the chart/log accordion. Rebuilt per tick — action enablement
	 * follows the job status.
	 */
	private jobQueueCard(job: AiToolkitJob): HTMLElement {
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
		const actions = el("div", { cls: "arthur-actions" });
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

		const pct = jobStepPct(job);
		const card = el("div", {
			cls: `arthur-queue-job arthur-queue-job--training arthur-job--${job.status}`,
			attrs: { id: `arthur-training-row-${job.id}` },
		});
		card.append(
			el("div", {
				cls: "arthur-card-head",
				children: [
					el("span", { cls: `arthur-badge ${jobBadgeCls(job.status)}`, text: job.status }),
					el("span", { cls: "arthur-card-title", text: name, attrs: { title: job.name } }),
					el("span", { cls: "arthur-card-meta", text: `GPUs ${job.gpu_ids || "?"}` }),
					el("span", {
						cls: "arthur-card-meta",
						text: `${job.step}/${job.total_steps ?? "?"} · ${job.speed_string || "—"}`,
					}),
				],
			}),
		);
		if (running && pct != null) {
			const fill = el("div", { cls: "arthur-bar-fill" });
			fill.style.width = `${pct}%`;
			card.append(el("div", { cls: "arthur-bar", children: [fill] }));
		}
		card.append(actions);
		if (ui.chart || ui.logs) {
			card.append(this.jobPanelStack(job.id, ui));
			if (ui.chart) void this.fetchJobLoss(job.id);
			if (ui.logs) void this.fetchJobLog(job.id);
		}
		return card;
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
		this.renderQueue();
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

	/** Accordion stack (chart / log panels) inside a training job card — the
	 *  mounted containers are registered in jobPanelEls so the incremental
	 *  fetchers repaint them in place. */
	private jobPanelStack(jobId: string, ui: JobPanelUi): HTMLElement {
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
		this.jobPanelEls.set(jobId, mounted);
		if (mounted.chart) this.renderJobChart(mounted.chart, jobId);
		if (mounted.log) this.renderJobLog(mounted.log, jobId);
		return stack;
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
			this.updateGridProgress(port);
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
			case "execution_start":
				// Run-start tracking: the precise local source for the grid's
				// run-duration sort (falls back to the agent uptime otherwise).
				this.runStarts.set(`run:${port}`, Date.now());
				return;
			case "execution_success":
			case "execution_error":
			case "execution_interrupted":
				panel.progress = null;
				panel.runningPromptId = null;
				panel.promptGraph = null;
				this.runStarts.delete(`run:${port}`);
				this.updateGridProgress(port);
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
