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
 *   0c. SECTION TITLES — INSTANCES and JOB QUEUE each open with a centered,
 *                    click-to-toggle collapse header ('Instances', 'Queue')
 *                    with a rotating chevron; collapsed state persists per
 *                    section in the plugin settings (instancesCollapsed /
 *                    queueCollapsed). The error banner sits ABOVE both
 *                    collapsibles and never collapses.
 *   1. INSTANCES   — the GPU instance grid: one COLUMN per GPU (live stats
 *                    from GET /api/gpus, agent v0.5.4) and a ROW-PACKED row
 *                    set (instances whose GPU sets don't overlap share a
 *                    visual row via the packer; multi-GPU/dual spans get their
 *                    own full row) for each GPU-owning comfy instance
 *                    queued/running ai-toolkit training job — HIDDEN entirely
 *                    while the comfyui service is inactive (v0.7.1: stop-all
 *                    leaves only the grey service pill; a stopped service's
 *                    leftover default instance renders no row). Rows are
 *                    self-contained outlined cards (running = accent tint,
 *                    idle = neutral, down = dashed muted + grayscale),
 *                    carrying a state badge (running/idle/down), quick run
 *                    stats for running rows (WS progress / job step+speed),
 *                    lifecycle + queue buttons for instances (down rows get
 *                    Start + Remove — remove forgets the stopped instance via
 *                    /forget; the agent's DEFAULT instance is never forgettable
 *                    and gets Start only; up comfy rows get Clear-queue +
 *                    Free-VRAM), a
 *                    two-line stats block (VRAM used/total matched from
 *                    /api/gpus + pending queue depth + a small WS state chip),
 *                    and a 'view in queue ↓' link for running rows WITH queue
 *                    jobs that scrolls to the matching job-queue anchor
 *                    below. Single-GPU ai-toolkit queue sets surface as tiny
 *                    play/pause chips on their GPU column headers. Idle rows sort first, running
 *                    rows by run duration (longest first); run starts are
 *                    tracked locally (WS execution_start / queue transition;
 *                    agent uptime as fallback). /api/gpus unreachable →
 *                    columns derived from the instance gpus arrays (settings
 *                    fallback: 2) with a 'gpu stats unavailable' note; agent
 *                    fully down → grid hidden, the settings comfyPorts render
 *                    as unmanaged rows.
 *   2. JOB QUEUE   — ONE PURE JOB LIST below the grid (v0.6.3 restructure:
 *                    the per-instance group headers, the per-GPU-set queue
 *                    toggles block and the 'no jobs' note are GONE — empty
 *                    queue = no cards at all; the clear-queue/free-VRAM
 *                    actions moved onto the grid cards and the per-GPU-set
 *                    toggles onto GPU column headers / matching training
 *                    cards). Job cards only: the comfy instance's running
 *                    generation (inline instance label 'comfy-0 · :8188' +
 *                    live WS progress + cancel + preview strip), pending
 *                    prompts (inline label + per-prompt ✕ delete) and
 *                    ai-toolkit training entries (arthur-training-row-<id>
 *                    anchor, full action set + accordion — multi-GPU queue
 *                    sets surface as a small toggle chip on matching cards).
 *                    The stable anchor id arthur-queue-<port> lives on the
 *                    instance's FIRST job card (running, else pending); the
 *                    grid's 'view in queue ↓' link only renders while that
 *                    anchor exists. The two ai-toolkit collectors (jobs /
 *                    queues) are decoupled: a broken queue endpoint never
 *                    hides job cards, and a failed source is shown as ONE
 *                    inline degraded line inside the queue section instead of
 *                    a fake empty state. Ordering:
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
 * OPTIMISTIC SPAWN STATE (v0.7.2): service-bar start/spawn clicks insert an
 * optimistic pending row (pulsing 'spawning…' placeholder) into the grid
 * immediately — the UI no longer waits silently for the next poll to prove
 * the click landed. The pending row is replaced by the real instance as soon
 * as /api/status reports it (matched by the response's instance id/port);
 * if nothing matching appears within 45s the row flips to an error state
 * ('spawn did not come up — check server') and auto-dismisses at the next
 * successful poll. Instances the plugin itself started/spawned within that
 * 45s window render 'spawning…' while they report up:false (ComfyUI boot
 * grace) instead of the alarmist 'down' state.
 *
 * Instance discovery (agent API v0.5.0): /api/status lists services with
 * computed instances; the queue groups + WS sockets attach to the
 * comfyui service's instance ports in agent order. The group set is rebuilt
 * only when that ordered port list changes (or the profile host changed).
 *
 * The view never mutates state optimistically — everything rendered comes
 * from the last poll fetch or the last WS event — with ONE exception (the
 * v0.7.2 optimistic spawn rows described above).
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
	gpuShortName,
	truncate,
} from "../util";
import { ArthurApiError, isTimeoutError } from "../api/transport";
import { ServiceBar } from "./service-bar";
import type { GpuMenuData } from "./service-bar";
import { confirmModal, describeError, run, toastErr, toastOk } from "./actions";
import { openUiTooltip, openWebUrl } from "./webviewer";

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

/** Optimistic spawn-state window (ms): a pending row times out (→ error
 *  state) after 45s without an /api/status match, and instances the plugin
 *  itself started/spawned render 'spawning…' (boot grace) for the same 45s
 *  while they still report up:false. */
const SPAWN_TIMEOUT_MS = 45_000;
/** pluginStarts prune floor (margin past the grace window). */
const SPAWN_START_PRUNE_MS = SPAWN_TIMEOUT_MS + 45_000;

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

/**
 * One sorted row of the instance grid (instance or training job). State adds
 * two optimistic values: 'spawning' (a plugin-started instance during boot,
 * or a service-bar click's pending placeholder) and 'failed' (a pending row
 * whose 45s match timeout elapsed).
 */
interface GridRowSpec {
	key: string;
	kind: "instance" | "training";
	title: string;
	gpus: number[];
	state: "running" | "idle" | "down" | "spawning" | "failed";
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
	/** 'view in queue ↓' link renders only while the queue section actually
	 *  holds a job card at that anchor (comfy: running or pending > 0). */
	linkable: boolean;
	// lifecycle wiring (instance rows only)
	svcId: string | null;
	instId: string | null;
	/** True when this is the agent's default instance (index-0 of a template
	 *  service / the single-instance service itself) — the agent refuses to
	 *  forget it (409), so its down rows hide the Remove button. */
	isDefault: boolean;
	/** Instance port (instance rows only) — run tracking + panel lookup. */
	port: number | null;
	/** systemd unit name (instance rows only, when the agent reports it). */
	unit?: string | null;
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
	/** GET /api/jobs answered? false = the jobs fetch failed (part-decoupled:
	 *  a queue failure never hides job cards, and vice versa). */
	reachable: boolean | null;
	jobs: AiToolkitJob[];
	/** GET /api/queue answered? Tracks the queue toggles independently of the
	 *  job list so a broken queue endpoint keeps training cards visible. */
	queuesOk: boolean | null;
	/** Flattened per-GPU-set queue rows (empty when the endpoint failed). */
	queues: Array<{ id: string | number; gpu_ids: string; is_running: boolean }>;
	/** Last error text per part (banner + inline queue state). */
	jobsError: string | null;
	queueError: string | null;
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
	/** Inline card label: instance id + port, or "unmanaged" on the
	 *  settings-fallback list. */
	label: string;
}

/** Cached DOM widgets + bookkeeping for one comfy port's queue cards. */
interface GenPanel {
	port: number;
	// running job card (anchor id arthur-queue-<port> while it is the
	// instance's first job): inline instance label + live WS progress + cancel
	// + preview strip
	runningCard: HTMLElement;
	runLabel: HTMLElement;
	runningTextEl: HTMLElement;
	progressFill: HTMLElement;
	progressLabel: HTMLElement;
	btnCancel: HTMLButtonElement;
	// live preview strip (WS binary frames → newest-first thumbnails)
	previewStrip: HTMLElement;
	// pending job card (inline instance label + per-prompt ✕ delete rows)
	pendingWrap: HTMLElement;
	pendingLabel: HTMLElement;
	pendingMeta: HTMLElement;
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

/**
 * One optimistic spawn pending (service-bar start/spawn click): a pulsing
 * 'spawning…' grid placeholder that resolves into the REAL instance row as
 * soon as /api/status reports a matching instance, or times out (error row)
 * after SPAWN_TIMEOUT_MS. Never mutated server-side, never persisted.
 */
interface SpawnPending {
	/** Stable key (map key; suffixed into the row's data-row-key). */
	k: string;
	svcId: string;
	/** 'start' → the service's default instance; 'spawn' → a new instance. */
	mode: "start" | "spawn";
	title: string;
	/** GPUs known/pre-selected at click time (spawn mode; may be empty). */
	gpus: number[];
	/** Match targets for poll resolution (id from the request response when
	 *  it carried the instance, otherwise the service's default id/port). */
	expectId: string | null;
	expectPort: number | null;
	createdAt: number;
	/** Flipped on the tick that first observed the 45s timeout; the NEXT
	 *  successful poll auto-dismisses the error row. */
	failed: boolean;
}

/** Never-throw wrapper for best-effort probes — keeps the error for diagnostics. */
async function tryCall<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: unknown }> {
	try {
		return { value: await fn(), error: null };
	} catch (err) {
		return { value: null, error: err };
	}
}

/** Synthetic (stats-less) column for placements derived without /api/gpus. */
function syntheticCol(index: number): GridCol {
	return { index, name: `GPU ${index}`, usedMb: null, totalMb: null, util: null, tempC: null };
}

/** Column placement of one row: lowest matching column index + a span over
 *  the columns the row's GPU list covers (multi-GPU rows bridge columns).
 *  Shared by the row packer and the row element builder. */
function gridRowPlacement(spec: GridRowSpec, cols: GridCol[]): { start: number; span: number } {
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
	return { start: colStart, span };
}

/**
 * Row packer: walk the rows in their given (sorted) order and place each
 * into the FIRST grid row whose covered columns are all free — instances
 * whose GPU sets don't overlap share a visual row (comfy-0 on GPU0 + comfy-1
 * on GPU1 = one row, two cells), while a dual-GPU row's covered columns push
 * it onto its own full row. Column count is unchanged (one per GPU); only
 * the row assignment changes. Returns the 0-based packed row per row key.
 */
function packRowPlacements(rows: GridRowSpec[], cols: GridCol[]): Map<string, number> {
	const placements = new Map<string, number>();
	/** Occupied column indexes per used grid row (0-based, header excluded). */
	const occupied: Array<Set<number>> = [];
	for (const spec of rows) {
		const { start, span } = gridRowPlacement(spec, cols);
		const covered: number[] = [];
		for (let c = start; c < start + span && c < cols.length; c++) covered.push(c);
		if (covered.length === 0) covered.push(start);
		let row = -1;
		for (let r = 0; r < occupied.length; r++) {
			if (covered.every((c) => !occupied[r].has(c))) {
				row = r;
				break;
			}
		}
		if (row < 0) {
			row = occupied.length;
			occupied.push(new Set());
		}
		for (const c of covered) occupied[row].add(c);
		placements.set(spec.key, row);
	}
	return placements;
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
	/** Error banner — sits outside both collapsibles; always shows when
	 *  unhealthy (hidden while every service answers). */
	private bannerEl!: HTMLElement;
	/** Instances section: centered collapsible title head + scrollable body
	 *  holding the grid, its notes and the unmanaged-row fallback. */
	private gridHeadEl!: HTMLElement;
	private gridBodyEl!: HTMLElement;
	/** Job queue section: centered collapsible title head + body. */
	private queueHeadEl!: HTMLElement;
	private queueBodyEl!: HTMLElement;
	/** Instance grid + its notes (replaced by unmanaged rows when agent down). */
	private gridEl!: HTMLElement;
	private gridNoteEl!: HTMLElement;
	private unmanagedEl!: HTMLElement;
	/** Unified job queue (pure job list: running + pending cards + training
	 *  cards, ordered per tick by the queue sorting rules — no group headers,
	 *  no toggles block, no empty-queue note). */
	private queueEl!: HTMLElement;
	/** The queue section's ONE subtle degraded line: shown only while a source
	 *  errored (ai-toolkit collectors, unreachable comfy ports, or the
	 *  watchdog's stuck-collector states) — never a fake empty state. */
	private aiStateEl!: HTMLElement;
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
		queuesOk: null,
		queues: [],
		jobsError: null,
		queueError: null,
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
	/** Cached progress + WS-chip widgets of live grid rows, keyed like
	 *  runStarts — WS ticks repaint them without a grid rebuild. */
	private readonly gridRows = new Map<
		string,
		{
			progressFill: HTMLElement | null;
			progressLabel: HTMLElement | null;
			wsChip: HTMLElement | null;
		}
	>();
	/** Latest per-row run durations from buildGridRows ("inst:<id>" / "job:<id>")
	 *  — the unified queue's duration sort reuses them so the run-start
	 *  bookkeeping runs exactly once per tick. */
	private readonly gridRowDurations = new Map<string, number | null>();

	/** Expanded instance-card detail panels (accordion, keys = instance ids).
	 *  Kept OUTSIDE the DOM because the grid rebuilds per poll tick — expansion
	 *  must persist across re-renders. Pruned on each tick against the agent's
	 *  live instance list (v0.5.4 stop-all forgets instances — a forgotten id
	 *  must not linger expanded). */
	private readonly expandedInstances = new Set<string>();
	/** Rows queued for an expand ANIMATION on the next grid render (a re-render
	 *  from a poll must paint panels already-open, never re-run the animation). */
	private readonly expandAnimationPending = new Set<string>();

	// optimistic spawn state (service-bar clicks; view-local, never persisted)
	/** Pending 'spawning…' rows keyed by their stable pending key. */
	private readonly spawnPendings = new Map<string, SpawnPending>();
	/** Monotonic seq for placeholder ids (spawning-<svc>-<n>). */
	private spawnSeq = 0;
	/** Instances the plugin itself started/spawned (id / `port:N` keys → epoch
	 *  ms) — within the 45s window an up:false report renders 'spawning…' not
	 *  'down' (ComfyUI boot grace). */
	private readonly pluginStarts = new Map<string, number>();

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
					label: `${i.id} · :${i.port}`,
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
		this.expandedInstances.clear();
		this.expandAnimationPending.clear();
		this.spawnPendings.clear();
		this.pluginStarts.clear();
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
		this.expandedInstances.clear();
		this.expandAnimationPending.clear();
		this.spawnPendings.clear();
		this.pluginStarts.clear();
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
			// Degraded line in the queue section (the only tail element) — the
			// next settled tick repaints the truth.
			this.paintDegraded(
				[`comfy :${port} — ${mark}`],
				errTooltip(hostPort, mark),
			);
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
				reachable: null,
				jobs: [],
				queuesOk: null,
				queues: [],
				jobsError: "not configured",
				queueError: "not configured",
			};
			this.gpuDetail = { list: [], error: null };
			this.spawnPendings.clear();
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
		// Optimistic spawn pendings: resolve against the fresh status (or time
		// out into the error row) BEFORE the grid renders.
		this.tickSpawnPendings();
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
		// An instance that just went down / was dropped from the registry must
		// lose its socket at this tick, even when no rebuild fired.
		this.syncWss();

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

		const [jobsRes, queueRes] = await Promise.all([
			tryCall(() => clients.aitoolkit.jobs()),
			tryCall(() => clients.aitoolkit.queueList()),
		]);
		// The two ai-toolkit collectors are decoupled ON PURPOSE: /api/jobs
		// answers → training job cards render even when /api/queue fails (the
		// broken queue endpoint only costs the per-GPU-set toggles), and a jobs
		// failure collapses to an inline degraded state in the queue instead of
		// a fake "every queue is clear" note.
		this.aiDetail = {
			reachable: jobsRes.value !== null,
			jobs: jobsRes.value?.jobs ?? [],
			queuesOk: queueRes.value !== null,
			queues: queueRes.value
				? (queueRes.value.queues ?? []).map(
						(q): AiToolkitQueueRow => ({
							id: q.id,
							gpu_ids: q.gpu_ids,
							is_running: q.is_running,
						}),
				  )
				: [],
			jobsError: jobsRes.value === null ? describeError(jobsRes.error) : null,
			queueError: queueRes.value === null ? describeError(queueRes.error) : null,
		};
		// Jobs/queues settled — data or error, always a renderable state.
		this.watchSettle("training");

		this.lastTick = Date.now();
		this.trainingStuck = false;
		this.renderBanner();
		this.renderServiceBar();
		this.pruneExpandedInstances();
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
			parts.push(
				`aitk jobs ${this.outcomeFor(jobsRes.error)} · queues ${this.outcomeFor(queueRes.error)} ${hostPort(profile.aiToolkitPort)}`,
			);
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
			// Hover GPU dropdown (multi-instance services): live GPU stats +
			// occupants, with the selection persisted per service in settings.
			gpuMenuData: (svcId) => this.svcGpuMenuData(svcId),
			gpuSelection: (svcId) => this.gpuSelectionFor(svcId),
			setGpuSelection: (svcId, gpus) => this.setGpuSelection(svcId, gpus),
		});

		// ONE slim error banner under the service bar — dead services + last
		// error + attempted host:port; hidden entirely while all healthy. Also
		// carries the 'not configured' / token / version-mismatch states. It is
		// OUTSIDE both section collapsibles — it always shows when unhealthy.
		this.bannerEl = root.createEl("div", { cls: "arthur-banner" });
		this.bannerEl.hide();

		// 1. INSTANCES — collapsible section: a centered click-to-toggle title
		// line ('Instances' + chevron) above the grid body (grid + notes +
		// unmanaged-row fallback). Collapse state persists in the settings.
		const gridSection = root.createEl("div", { cls: "arthur-section" });
		this.gridHeadEl = this.buildSectionHead("instances");
		gridSection.append(this.gridHeadEl);
		this.gridBodyEl = gridSection.createEl("div", { cls: "arthur-section-body" });
		this.gridHeadEl.setAttribute("aria-controls", "arthur-section-instances");
		this.gridBodyEl.setAttribute("id", "arthur-section-instances");
		this.gridEl = this.gridBodyEl.createEl("div", { cls: "arthur-grid" });
		this.gridEl.append(el("p", { cls: "arthur-note", text: "loading…" }));
		this.gridNoteEl = this.gridBodyEl.createEl("p", {
			cls: "arthur-note",
			text: "",
		});
		this.gridNoteEl.hide();
		this.unmanagedEl = this.gridBodyEl.createEl("div", { cls: "arthur-cards" });
		this.unmanagedEl.hide();

		// 2. JOB QUEUE — collapsible section ('Queue' + chevron) wrapping the
		// ONE pure job list: per-port cached cards (running + pending) ordered
		// per tick by the queue sorting rules, training job cards rebuilt per
		// tick. Re-attaching the cached nodes preserves the WS-facing widget
		// refs (progress bars never need a rebuild).
		const queueSection = root.createEl("div", { cls: "arthur-section" });
		this.queueHeadEl = this.buildSectionHead("queue");
		queueSection.append(this.queueHeadEl);
		this.queueBodyEl = queueSection.createEl("div", { cls: "arthur-section-body" });
		this.queueHeadEl.setAttribute("aria-controls", "arthur-section-queue");
		this.queueBodyEl.setAttribute("id", "arthur-section-queue");
		this.queueEl = this.queueBodyEl.createEl("div", { cls: "arthur-queue" });
		for (const p of ports) {
			this.buildGenGroup(p);
		}
		// Queue tail: the ONE inline degraded state for a failed source (never
		// a fake empty state — an empty queue is simply no job cards).
		this.aiStateEl = this.queueEl.createEl("div", { cls: "arthur-aiqueue-state" });
		this.aiStateEl.hide();

		// Port list the groups+WS are now built for.
		this.activePorts = ports;
		this.skeletonBuilt = true;
		// Body elements now exist — paint each section's persisted collapse state.
		this.syncSectionCollapse("instances");
		this.syncSectionCollapse("queue");
	}

	/**
	 * One collapsible section head: a centered title line ('Instances' or
	 * 'Queue') with a rotating chevron. Clicking (or Enter/Space while
	 * focused) toggles that section's body; the state persists per section
	 * in the plugin settings. Returns the head element.
	 */
	private buildSectionHead(section: "instances" | "queue"): HTMLElement {
		const head = el("div", {
			cls: "arthur-section-head",
			attrs: {
				"data-section": section,
				role: "button",
				tabindex: "0",
				"aria-expanded": "true",
				title: `Toggle the ${section === "instances" ? "instance grid" : "job queue"} section`,
			},
		});
		head.append(
			el("span", {
				cls: "arthur-section-title",
				text: section === "instances" ? "Instances" : "Queue",
			}),
			el("span", { cls: "arthur-section-chevron", attrs: { "aria-hidden": "true" } }),
		);
		head.addEventListener("click", () => this.toggleSection(section));
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.toggleSection(section);
			}
		});
		return head;
	}

	/** Click-to-toggle one section: flip the persisted setting, save, repaint. */
	private toggleSection(section: "instances" | "queue"): void {
		const s = this.plugin.settings;
		if (section === "instances") s.instancesCollapsed = !s.instancesCollapsed;
		else s.queueCollapsed = !s.queueCollapsed;
		void this.plugin.saveSettings(); // persist through loadData/saveData
		this.syncSectionCollapse(section);
	}

	/** Paint one section's collapse state (body hidden + collapsed head). */
	private syncSectionCollapse(section: "instances" | "queue"): void {
		const collapsed =
			section === "instances"
				? this.plugin.settings.instancesCollapsed === true
				: this.plugin.settings.queueCollapsed === true;
		const body = section === "instances" ? this.gridBodyEl : this.queueBodyEl;
		const head = section === "instances" ? this.gridHeadEl : this.queueHeadEl;
		if (collapsed) {
			body.hide();
			head.addClass("arthur-section-head--collapsed");
		} else {
			body.show();
			head.removeClass("arthur-section-head--collapsed");
		}
		head.setAttribute("aria-expanded", String(!collapsed));
	}

	/**
	 * Build the queue cards for one port and cache their widgets: a running
	 * job card (carries the stable anchor id arthur-queue-<port> while it is
	 * the instance's first job; inline instance label + live WS progress +
	 * cancel + preview strip) and a pending card (inline instance label +
	 * per-prompt ✕ delete rows). The nodes are cached for the view's
	 * lifetime; per-tick renderQueue only repaints + reorders them.
	 */
	private buildGenGroup(p: DesiredPort): void {
		const port = p.port;

		// running job card — the only place the live WS progress surfaces
		const progressFill = el("div", { cls: "arthur-bar-fill" });
		progressFill.style.width = "0%";
		const progressLabel = el("span", { cls: "arthur-card-meta", text: "idle" });
		const runningTextEl = el("span", { cls: "arthur-card-meta" });
		runningTextEl.hide();
		const runLabel = el("span", { cls: "arthur-queue-label", text: p.label });
		const previewStrip = el("div", { cls: "arthur-preview-strip" });
		previewStrip.hide();
		const btnCancel = newBtn("Cancel");
		btnCancel.addClass("arthur-btn--tiny");
		const runningCard = el("div", {
			cls: "arthur-queue-job arthur-queue-job--running",
			attrs: { "data-port": String(port) },
		});
		runningCard.append(
			el("div", {
				cls: "arthur-card-head",
				children: [
					runLabel,
					runningTextEl,
					el("div", { cls: "arthur-btn-row", children: [btnCancel] }),
				],
			}),
			el("div", { cls: "arthur-bar", children: [progressFill] }),
			progressLabel,
			previewStrip,
		);
		runningCard.hide();

		// pending card — one compact row per queued prompt, refilled per tick
		const pendingLabel = el("span", { cls: "arthur-queue-label", text: p.label });
		const pendingMeta = el("span", { cls: "arthur-card-meta" });
		const pendingWrap = el("div", {
			cls: "arthur-pending-list arthur-queue-job arthur-queue-job--pending",
			attrs: { "data-port": String(port) },
		});
		pendingWrap.append(
			el("div", { cls: "arthur-card-head", children: [pendingLabel, pendingMeta] }),
		);
		pendingWrap.hide();

		btnCancel.addEventListener("click", () => void this.cancelRunning(port));

		this.panels.set(port, {
			port,
			runningCard,
			runLabel,
			runningTextEl,
			progressFill,
			progressLabel,
			btnCancel,
			pendingWrap,
			pendingLabel,
			pendingMeta,
			previewStrip,
			progress: null,
			promptGraph: null,
			runningPromptId: null,
			pendingIds: [],
			previewUrls: [],
		});
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
		if (this.aiDetail.reachable === false && this.aiDetail.jobsError) {
			errors.push(`ai-toolkit ${hostPort(clients?.profile.aiToolkitPort ?? 0)} — jobs: ${this.aiDetail.jobsError}`);
		} else if (this.aiDetail.queuesOk === false && this.aiDetail.queueError) {
			errors.push(`ai-toolkit ${hostPort(clients?.profile.aiToolkitPort ?? 0)} — queues: ${this.aiDetail.queueError}`);
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
		this.syncSectionCollapse("instances");
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
			// Service-inactive grid (device report v0.7.0): when the agent reports
			// the comfyui service INACTIVE (stop-all), its instance rows are
			// hidden from the grid entirely — the greyed service-bar pill already
			// represents the stopped service, and the leftover default remains
			// listed (up:false) but must not render. A merely DOWN instance while
			// the service is still active keeps its down row (Start + Remove).
			const serviceActive = comfy?.active !== false;
			// Non-GPU instances (e.g. the aitoolkit UI service) are not grid
			// rows — they live in the service bar.
			const gpuList = inst.gpus?.length ? inst.gpus : inst.gpu != null ? [inst.gpu] : [];
			if (!serviceActive || gpuList.length === 0) continue;
			const idx = this.activePorts.findIndex((p) => p.port === inst.port);
			const detail = idx >= 0 ? this.comfyDetail[idx] ?? null : null;
			const runningCount =
				inst.up && Array.isArray(detail?.queue?.queue_running)
					? detail!.queue!.queue_running.length
					: 0;
			const running = runningCount > 0;
			const pendingCount =
				inst.up && Array.isArray(detail?.queue?.queue_pending)
					? detail!.queue!.queue_pending.length
					: 0;
			const key = `run:${inst.port}`;
			const duration = runDuration(key, running);
			const effective = duration ?? (running ? (inst.uptime ?? null) : null);
			this.gridRowDurations.set(key, effective);
			const panel = this.panels.get(inst.port);
			// Boot grace: an instance the plugin itself started/spawned within the
			// last 45s reports up:false while ComfyUI boots — render 'spawning…'
			// (muted pulsing row) instead of the alarmist 'down'.
			const booting = !inst.up && this.pluginBootGrace(inst) !== null;
			rows.push({
				key: `inst:${inst.id}`,
				kind: "instance",
				title: inst.name ?? inst.id,
				gpus: gpuList,
				state: !inst.up ? (booting ? "spawning" : "down") : running ? "running" : "idle",
				badge: !inst.up ? (booting ? "spawning…" : "down") : running ? "running" : "idle",
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
				// 'view in queue ↓' only while the queue section actually holds
				// a job card at that anchor (running or pending > 0).
				linkable: running && runningCount + pendingCount > 0,
				svcId: inst.service,
				instId: inst.id,
				// The agent's default instance (index-0 of a template service —
				// e.g. comfy-0 on the default port — or the sole instance of a
				// single-unit service) cannot be forgotten — /forget 409s
				// 'default instance cannot be forgotten' — so its down rows hide
				// the Remove button. Detection signal: the SERVICE model's
				// default_port (the default instance is always spawned on it).
				isDefault: comfy != null && inst.port === comfy.default_port,
				port: inst.port,
				unit: inst.unit ?? null,
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
					linkable: true,
					svcId: null,
					instId: null,
					isDefault: false,
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

		// Optimistic spawn pendings (service-bar clicks) — always trailing rows:
		// pulsing 'spawning…' placeholders, or the 45s-timeout error row.
		const nowMs = Date.now();
		for (const p of this.spawnPendings.values()) {
			const failed = p.failed || nowMs - p.createdAt > SPAWN_TIMEOUT_MS;
			rows.push({
				key: `pending:${p.k}`,
				kind: "instance",
				title: p.title,
				gpus: p.gpus,
				state: failed ? "failed" : "spawning",
				badge: failed ? "spawn error" : "spawning…",
				meta: failed
					? "spawn did not come up — check server"
					: p.expectPort != null
						? `:${p.expectPort}${p.gpus.length ? ` · GPU ${p.gpus.join(",")}` : ""}`
						: p.gpus.length
							? `GPU ${p.gpus.join(",")}`
							: "new instance",
				durationSec: null,
				prompt: null,
				statsText: null,
				statsPct: null,
				anchor: "",
				// Pendings are placeholders — no queue link, no lifecycle buttons,
				// no expansion, no stats block.
				linkable: false,
				svcId: p.svcId,
				instId: null,
				isDefault: false,
				port: null,
			});
		}
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
			// Single-GPU ai-toolkit queue set ('0' → GPU0): a tiny play/pause
			// chip on that column's header chip (multi-GPU sets live on the
			// matching training job cards instead).
			const gpuQueue = this.aiDetail.queues.find(
				(q) => q.gpu_ids.trim() === String(col.index),
			);
			if (this.aiDetail.queuesOk === true && gpuQueue) {
				head.append(this.queueToggleChip(gpuQueue));
			}
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

		// Service-inactive note (device report v0.7.0): the comfyui service is
		// stopped (stop-all) — its rows are hidden; the grey service pill owns
		// the lifecycle, so the grid says so instead of rendering leftovers.
		const comfySvc = this.agentDetail.status?.services.find((s) => s.id === "comfyui") ?? null;
		if (comfySvc && comfySvc.active === false) {
			this.gridNoteEl.setText("ComfyUI service stopped — click the grey ComfyUI pill above to start it");
			this.gridNoteEl.show();
		}

		// Row packer: sorted rows stack onto the first packed row whose columns
		// are free — disjoint GPU sets share a visual row, overlapping spans
		// (multi-GPU) fall onto their own full row.
		const pack = packRowPlacements(rows, cols);
		rows.forEach((spec) =>
			grid.append(this.gridRowEl(spec, cols, pack.get(spec.key) ?? 0)),
		);
	}

	/** One row cell, spanning its GPU column(s); `packRow` is the 0-based packed
	 *  grid row from packRowPlacements (the header occupies grid row 1). */
	private gridRowEl(spec: GridRowSpec, cols: GridCol[], packRow: number): HTMLElement {
		// Placement: lowest matching column index + a span over the columns the
		// row's GPU list covers (multi-GPU rows visually bridge the columns).
		const { start: colStart, span } = gridRowPlacement(spec, cols);

		const cell = el("div", {
			cls: `arthur-grid-row arthur-grid-row--${spec.state}`,
			attrs: { "data-row-key": spec.key },
		});
		cell.style.gridColumn = `${colStart + 1} / span ${span}`;
		cell.style.gridRow = `${packRow + 2}`;

		const dotCls =
			spec.state === "running"
				? "arthur-dot arthur-dot--green"
				: spec.state === "down" || spec.state === "failed"
					? "arthur-dot arthur-dot--red"
					: "arthur-dot arthur-dot--gray";
		// Web-UI link (up comfy instance cards): small ↗ icon next to the badge —
		// opens http://<host>:<port> in Obsidian's web-viewer core plugin (or the
		// external browser when that plugin is disabled — the tooltip says which).
		const webui = spec.kind === "instance" && spec.state !== "down" && spec.port != null
			? this.buildOpenUiIcon(spec)
			: null;
		const head = el("div", { cls: "arthur-grid-row-head" });
		head.append(
			el("span", { cls: dotCls }),
			el("span", { cls: "arthur-grid-title", text: spec.title }),
			el("span", { cls: "arthur-card-meta", text: spec.meta }),
			el("span", {
				cls: "arthur-grid-head-tail",
				children: [
					...(webui ? [webui] : []),
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

		// Expanded-card tracking (click-to-expand accordion, see below).
		const expanded = spec.kind === "instance"
			&& spec.instId != null
			&& this.expandedInstances.has(spec.instId);

		// Lifecycle buttons (instance rows only) — up rows: Start/Stop/Restart;
		// down rows: Start + Remove (forget the stopped instance from the agent);
		// still-booting 'spawning…' rows: Start only — nothing is running yet.
		// EXPANDED cards drop the inline buttons — the lifecycle set lives inside
		// the detail panel instead, so the collapsed head stays clean.
		if (spec.kind === "instance" && spec.svcId && spec.instId && !expanded) {
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
				const widgets = this.gridRows.get(`run:${spec.port!}`) ?? {
					progressFill: null,
					progressLabel: null,
					wsChip: null,
				};
				widgets.progressFill = progressFill;
				widgets.progressLabel = progressLabel;
				this.gridRows.set(`run:${spec.port!}`, widgets);
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
			if (spec.linkable) {
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
		}

		// Two compact stats lines for UP comfy instance cards: VRAM used/total
		// (matched from /api/gpus by the instance's gpu indexes) + pending queue
		// depth, then a small WS state chip + the clear-queue/free-VRAM actions.
		if (spec.kind === "instance" && spec.state !== "down" && spec.port != null) {
			const detail = this.comfyDetailFor(spec.port);
			const pendingCount = Array.isArray(detail?.queue?.queue_pending)
				? detail!.queue!.queue_pending.length
				: 0;
			let vramUsed = 0;
			let vramTotal = 0;
			let vramMatched = false;
			for (const g of spec.gpus) {
				const col = cols.find((c) => c.index === g);
				if (col && col.usedMb != null && col.totalMb != null && col.totalMb > 0) {
					vramMatched = true;
					vramUsed += col.usedMb;
					vramTotal += col.totalMb;
				}
			}
			const statParts = [
				vramMatched ? `VRAM ${fmtGigCompact(vramUsed)}/${fmtGigCompact(vramTotal)}` : null,
				pendingCount > 0 ? `queue ${pendingCount}` : null,
			].filter((s): s is string => s !== null);
			if (statParts.length > 0) {
				cell.append(el("span", { cls: "arthur-card-meta arthur-grid-stats", text: statParts.join(" · ") }));
			}
			// WS state chip (small live/connecting/down/off) + queue actions row.
			const statsRow = el("div", { cls: "arthur-grid-stats-row" });
			const wsChip = el("span", { cls: "arthur-ws-chip" });
			this.paintWsChip(wsChip, this.wss.get(spec.port)?.currentState ?? WsState.Closed);
			statsRow.append(wsChip);
			const widgets = this.gridRows.get(`run:${spec.port}`) ?? {
				progressFill: null,
				progressLabel: null,
				wsChip: null,
			};
			widgets.wsChip = wsChip;
			this.gridRows.set(`run:${spec.port}`, widgets);
			const client = this.clientFor(spec.port);
			if (client) {
				const btnClear = newBtn("Clear queue");
				btnClear.addClass("arthur-btn--tiny");
				btnClear.addEventListener("click", () => {
					confirmModal(
						this.app,
						"Clear queue",
						`Delete all ${pendingCount} pending prompt${pendingCount === 1 ? "" : "s"} on port ${spec.port}?`,
						() => void this.clearQueue(spec.port!),
					);
				});
				const btnFree = newBtn("Free VRAM");
				btnFree.addClass("arthur-btn--tiny");
				btnFree.addEventListener("click", () => {
					confirmModal(
						this.app,
						"Free VRAM",
						`Unload models and free memory on port ${spec.port}? Models reload on the next generation.`,
						() => void this.freeVram(spec.port!),
					);
				});
				statsRow.append(btnClear, btnFree);
			}
			cell.append(statsRow);
		}

		// Click-to-expand (instance cards): clicking the card (but NOT its
		// buttons/links) toggles a detail accordion below the card head. The
		// expanded flag lives in this.expandedInstances — keyed by instance id —
		// so it survives the grid's per-tick rebuilds. The panel renders on top
		// here; a poll-driven re-render paints already-open, never re-animating.
		if (spec.kind === "instance" && spec.instId != null) {
			cell.addClass("arthur-grid-row--expandable");
			cell.setAttribute("title", expanded ? "Click to collapse" : "Click to expand");
			if (expanded) {
				cell.addClass("arthur-grid-row--expanded");
				cell.append(this.buildInstancePanel(spec, cols));
			}
			cell.addEventListener("click", (e) => this.toggleInstanceExpanded(spec, e));
		}
		return cell;
	}

	/**
	 * Toggle one instance card's detail accordion. Clicks originating on a
	 * button/link inside the card are ignored (they own their clicks). The
	 * grid re-renders to mount/unmount the detail panel; an expansion is
	 * flagged for the animated max-height/accordion opening on that render.
	 */
	private toggleInstanceExpanded(spec: GridRowSpec, ev?: Event): void {
		if (ev) {
			const target = (ev.target ?? null) as
				| { closest?: (sel: string) => Element | null }
				| null;
			if (
				typeof target?.closest === "function"
				&& (target.closest("button") || target.closest("a"))
			) {
				return;
			}
		}
		const id = spec.instId;
		if (!id) return;
		if (this.expandedInstances.has(id)) {
			this.expandedInstances.delete(id);
			this.expandAnimationPending.delete(id);
		} else {
			this.expandedInstances.add(id);
			this.expandAnimationPending.add(id); // animate the OPEN only
		}
		this.renderInstances();
	}

	/**
	 * Drop expanded-card state for instances the agent no longer reports —
	 * v0.5.4 stop-all FORGETS every non-default instance, so a forgotten id
	 * must not keep lingering expanded state. Runs ONLY while the agent
	 * answers (a temporarily unreachable agent must not wipe the state).
	 */
	private pruneExpandedInstances(): void {
		const ad = this.agentDetail;
		if (ad.statusOk !== true || !ad.status) return;
		const ids = new Set(
			ad.status.services.flatMap((s) => s.instances.map((i) => i.id)),
		);
		for (const id of [...this.expandedInstances]) {
			if (!ids.has(id)) this.expandedInstances.delete(id);
		}
		this.expandAnimationPending.clear();
	}

	/** The instance-UI url (comfy web UI) for one instance row. */
	private instanceUiUrl(spec: GridRowSpec): string {
		return `http://${this.plugin.clients?.profile.host ?? ""}:${spec.port}`;
	}

	/**
	 * Small ↗ icon link on an up comfy instance card — opens the instance's
	 * web UI (http://<host>:<port>) via openWebUrl (web viewer / external).
	 */
	private buildOpenUiIcon(spec: GridRowSpec): HTMLElement {
		const url = this.instanceUiUrl(spec);
		const link = el("a", {
			cls: "arthur-inst-webui arthur-inst-webui--icon",
			text: "↗",
			attrs: { href: url },
		});
		link.setAttribute("title", openUiTooltip(this.app));
		link.addEventListener("click", (e) => {
			e.preventDefault();
			openWebUrl(this.app, url);
		});
		return link;
	}

	/**
	 * Open-instance-UI text link for the expanded detail panel + the tiny icon
	 * link. Both route through openWebUrl — web-viewer leaf (core plugin
	 * enabled) or external browser (disabled); the tooltip names the target.
	 */
	private buildOpenUiLink(spec: GridRowSpec): HTMLElement {
		const url = this.instanceUiUrl(spec);
		const link = el("a", {
			cls: "arthur-inst-webui",
			text: "Open instance UI ↗",
			attrs: { href: url },
		});
		link.setAttribute("title", openUiTooltip(this.app));
		link.addEventListener("click", (e) => {
			e.preventDefault();
			openWebUrl(this.app, url);
		});
		return link;
	}

	/**
	 * The expanded detail panel of one instance card: identity (id / name /
	 * port / service / systemd unit), per-GPU live stats (VRAM used/total +
	 * util + temp from /api/gpus), state + uptime, queue depth breakdown
	 * (running/pending for comfy), WS connection state, the full lifecycle
	 * button row (start/stop/restart/forget + clear/free-VRAM, duplicated from
	 * the collapsed head) and the open-instance-UI link. Rendered once per
	 * grid rebuild — poll ticks repaint it with fresh values; expansion
	 * persists because the state lives in this.expandedInstances.
	 */
	private buildInstancePanel(spec: GridRowSpec, cols: GridCol[]): HTMLElement {
		const instId = spec.instId ?? "";
		const detail = this.comfyDetailFor(spec.port ?? -1);
		const running = Array.isArray(detail?.queue?.queue_running)
			? detail!.queue!.queue_running.length
			: 0;
		const pending = Array.isArray(detail?.queue?.queue_pending)
			? detail!.queue!.queue_pending.length
			: 0;
		const stateRows: Array<[string, string]> = [
			["id", instId],
			["name", spec.title],
			["port", spec.port != null ? String(spec.port) : "—"],
			["state", spec.badge + (spec.state === "running" && spec.durationSec != null ? ` · ${fmtDuration(spec.durationSec)}` : "")],
			["uptime", spec.durationSec != null ? fmtDuration(spec.durationSec) : "—"],
			["queue", `running ${running} · pending ${pending}`],
			[
				"ws",
				(() => {
					const state = this.wss.get(spec.port ?? 0)?.currentState ?? WsState.Closed;
					return state === WsState.Open
						? "connected"
						: state === WsState.Connecting
							? "connecting"
							: state === WsState.Backoff
								? "down (reconnecting)"
								: "closed";
				})(),
			],
			["service", spec.svcId ?? "—"],
		];
		if (spec.unit) stateRows.push(["unit", spec.unit]);
		// Per-GPU live block (matched from /api/gpus columns by gpu index).
		for (const g of spec.gpus) {
			const col = cols.find((c) => c.index === g);
			stateRows.push([
				`gpu ${g}`,
				[
					col?.usedMb != null && col?.totalMb != null
						? `VRAM ${fmtGigCompact(col.usedMb)}/${fmtGigCompact(col.totalMb)}`
						: "VRAM ?",
					col?.util != null ? `util ${Math.round(col.util)}%` : null,
					col?.tempC != null ? `${Math.round(col.tempC)}°` : null,
				].filter((s): s is string => s !== null).join(" · "),
			]);
		}
		const dl = el("div", { cls: "arthur-inst-panel-grid" });
		for (const [key, value] of stateRows) {
			dl.append(
				el("span", { cls: "arthur-inst-panel-key", text: key }),
				el("span", { cls: "arthur-inst-panel-val", text: value }),
			);
		}

		// Actions row: the lifecycle buttons + the open-instance-UI link.
		const actions = spec.svcId && spec.instId ? this.gridLifecycleButtons(spec) : el("div", { cls: "arthur-btn-row" });
		actions.addClass("arthur-inst-panel-actions");
		actions.append(this.buildOpenUiLink(spec));

		const panel = el("div", { cls: "arthur-inst-panel" });
		panel.append(dl, actions);
		// Animate the expansion on the toggle that opened it; render-driven
		// rebuilds paint already-open (no re-animation on every 3s tick).
		if (this.expandAnimationPending.has(instId)) {
			this.expandAnimationPending.delete(instId);
			// Start closed, flip to open the next animation frame → the CSS
			// max-height transition runs (accordion opening). No rAF available
			// (test stubs / a plain render) → paint already-open.
			const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame;
			if (typeof raf === "function") raf(() => panel.addClass("arthur-inst-panel--open"));
			else panel.addClass("arthur-inst-panel--open");
		} else {
			panel.addClass("arthur-inst-panel--open");
		}
		return panel;
	}

	/** Start/stop/restart for one grid instance row (down rows: Start +
	 *  Remove — remove FORGETS the stopped instance from the agent's registry
	 *  after a destructive confirm) — reuses the agent lifecycle handlers with
	 *  the existing confirm/force (409) escalation contract. */
	private gridLifecycleButtons(spec: GridRowSpec): HTMLElement {
		const instName = spec.title;
		const op = (action: "start" | "stop" | "restart") =>
			void this.instanceLifecycle(spec.svcId!, spec.instId!, `${action} ${instName}`, action);
		const btnStart = newBtn("Start");
		btnStart.addClass("arthur-btn--tiny");
		btnStart.addEventListener("click", () => op("start"));
		const buttons: HTMLButtonElement[] = [btnStart];
		if (spec.state !== "down" && spec.state !== "spawning") {
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
		} else if (spec.svcId && spec.instId && !spec.isDefault) {
			// DOWN row: destructive remove — forgets the stopped instance from
			// the agent's registry (409 while it is still up; 404 unknown). The
			// agent's DEFAULT instance is never forgettable (409 'default
			// instance cannot be forgotten') — its down rows carry no Remove.
			const btnRemove = newBtn("Remove");
			btnRemove.addClass("arthur-btn--tiny");
			btnRemove.addEventListener("click", () =>
				confirmModal(
					this.app,
					"Remove instance",
					`Remove ${spec.instId} from the agent? It will no longer be listed.`,
					() => void this.instanceForget(spec.svcId!, spec.instId!),
				),
			);
			buttons.push(btnRemove);
		}
		return el("div", { cls: "arthur-btn-row", children: buttons });
	}

	/** Comfy detail for one port (null when the port isn't currently polled). */
	private comfyDetailFor(port: number): ComfyPortDetail | null {
		const idx = this.activePorts.findIndex((p) => p.port === port);
		return idx >= 0 ? this.comfyDetail[idx] ?? null : null;
	}

	/**
	 * Tiny play/pause chip for an ai-toolkit training queue row — on the GPU
	 * column header (single-GPU sets) or the matching training job card
	 * (multi-GPU sets). Starts/pauses the per-GPU-set queue with a toast +
	 * re-poll, never optimistic.
	 */
	private queueToggleChip(q: AiToolkitQueueRow): HTMLElement {
		const btn = newBtn(q.is_running ? "⏸" : "▶");
		btn.addClass("arthur-btn--tiny", "arthur-queue-toggle");
		btn.setAttribute(
			"title",
			`${q.is_running ? "Pause" : "Resume"} the training queue on GPU${q.gpu_ids.trim()}`,
		);
		btn.setAttribute("aria-label", btn.getAttribute("title") ?? "");
		btn.addEventListener("click", () =>
			void run(
				this.pollers(),
				`${q.is_running ? "pause" : "resume"} queue GPU${q.gpu_ids.trim()}`,
				() =>
					q.is_running
						? this.plugin.clients!.aitoolkit.queueStop(q.id)
						: this.plugin.clients!.aitoolkit.queueStart(q.id),
			),
		);
		return btn;
	}

	/** Repaint a small WS state chip (live / connecting / down / off). */
	private paintWsChip(chip: HTMLElement, state: WsState): void {
		chip.removeClass(
			"arthur-ws-chip--open",
			"arthur-ws-chip--connecting",
			"arthur-ws-chip--backoff",
			"arthur-ws-chip--closed",
		);
		chip.addClass(`arthur-ws-chip--${state}`);
		chip.setText(
			state === WsState.Open
				? "ws live"
				: state === WsState.Connecting
					? "ws connecting"
					: state === WsState.Backoff
						? "ws down"
						: "ws off",
		);
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
	// ONE pure job list — comfy running + pending cards merged with
	// ai-toolkit training cards, sorted:
	//   0. running (run duration desc, comfy before training on ties)
	//   1. pending/queued (comfy pending cards, then queued training jobs)
	//   2. recent stopped/error training jobs (newest first, cap 5)
	// NOTHING else renders: no group headers, no queue-toggles block, no
	// empty-queue note — an empty queue is simply no cards (group-header
	// actions moved to the grid cards; per-GPU-set toggles on GPU column
	// headers / matching training cards). The stable anchor id
	// arthur-queue-<port> sits on the instance's FIRST job card (running,
	// else pending).
	// ------------------------------------------------------------------

	/** Cap on the ranked-2 "recent stopped/error" training tail. */
	private static readonly RECENT_TRAINING_CAP = 5;

	private runSortSeconds(key: string): number {
		return this.gridRowDurations.get(key) ?? 0;
	}

	/**
	 * Repaint + reorder the pure job list. Cached nodes (running cards,
	 * pending cards) are moved, not rebuilt — WS-facing progress widgets keep
	 * their identity; training cards rebuild per tick (their action rows
	 * depend on the job status). The per-port anchor id moves to the
	 * instance's first job card (running card, else pending card).
	 */
	private renderQueue(): void {
		this.syncSectionCollapse("queue");
		const q = this.queueEl;
		const host = this.plugin.clients?.profile.host ?? "";
		const entries: QueueEntry[] = [];
		/** Attach/clear the stable anchor id on the instance's first job card. */
		const setAnchor = (port: number, firstCard: HTMLElement | null): void => {
			const panel = this.panels.get(port);
			if (!panel) return;
			for (const [card, isAnchor] of [
				[panel.runningCard, firstCard === panel.runningCard],
				[panel.pendingWrap, firstCard === panel.pendingWrap],
			] as Array<[HTMLElement, boolean]>) {
				if (isAnchor) card.setAttribute("id", `arthur-queue-${port}`);
				else card.removeAttribute("id");
			}
		};

		// comfy groups — running card first (rank 0), then pending card (rank 1);
		// an idle instance contributes NO cards (its clear-queue/free-VRAM
		// actions live on the grid card).
		this.activePorts.forEach((p, i) => {
			const panel = this.panels.get(p.port);
			if (!panel) return;
			const counts = this.updateGenEntry(panel, p, this.comfyDetail[i] ?? null, host);
			if (counts.running > 0) {
				const entry: QueueEntry = {
					rank: 0,
					sort: this.runSortSeconds(`run:${p.port}`),
					seq: i,
					nodes: [panel.runningCard],
				};
				panel.runningCard.show();
				setAnchor(p.port, panel.runningCard);
				entries.push(entry);
			} else {
				panel.runningCard.hide();
			}
			if (counts.pending > 0) {
				const entry: QueueEntry = { rank: 1, sort: 0, seq: i, nodes: [panel.pendingWrap] };
				panel.pendingWrap.show();
				setAnchor(p.port, counts.running > 0 ? panel.runningCard : panel.pendingWrap);
				entries.push(entry);
			} else {
				panel.pendingWrap.hide();
			}
			if (counts.running + counts.pending === 0) setAnchor(p.port, null);
		});

		// ai-toolkit training cards — running (rank 0, duration-sorted),
		// queued/stopping (rank 1, queue position first), recent stopped/error
		// (rank 2, newest updated_at first, capped). Gated on the JOBS
		// collector alone — a broken /api/queue only costs the per-GPU-set
		// queue toggles, never the job cards.
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
						// Next queue position first (the tick sort is descending,
						// so invert the position).
						sort: -(job.queue_position ?? 0),
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
		q.append(this.aiStateEl);
		// ONE inline degraded line for a failed source — comfy port probes, the
		// ai-toolkit collectors, or a watchdog-stuck collector. Never pretend an
		// unreachable source is an empty queue (an empty queue is simply NO job
		// cards — there is no 'no jobs' note anymore).
		const hostQ = this.plugin.clients?.profile.host ?? "";
		const aiPort = this.plugin.clients?.profile.aiToolkitPort ?? 0;
		const failedParts: string[] = [];
		const failedTips: string[] = [];
		this.activePorts.forEach((p, i) => {
			const d = this.comfyDetail[i];
			if (d?.online === false) {
				failedParts.push(
					`comfy :${p.port} unavailable — ${d.error ?? "not responding"}`,
				);
				failedTips.push(
					errTooltip(hostQ ? `${hostQ}:${p.port}` : "(not configured)", d.error),
				);
			}
		});
		if (this.aiDetail.reachable === false && this.aiDetail.jobsError) {
			failedParts.push(`training jobs unavailable — ${this.aiDetail.jobsError}`);
			failedTips.push(
				errTooltip(hostQ ? `${hostQ}:${aiPort}` : "(not configured)", this.aiDetail.jobsError),
			);
		}
		if (this.aiDetail.queuesOk === false && this.aiDetail.queueError) {
			failedParts.push(`queue toggles unavailable — ${this.aiDetail.queueError}`);
			failedTips.push(
				errTooltip(hostQ ? `${hostQ}:${aiPort}` : "(not configured)", this.aiDetail.queueError),
			);
		}
		if (hostQ && failedParts.length > 0) {
			this.aiStateEl.setText(failedParts.join(" · "));
			this.aiStateEl.setAttribute("title", failedTips.join("\n"));
			this.aiStateEl.show();
		} else {
			this.aiStateEl.hide();
		}
	}

	/** Paint the queue section's ONE degraded line (also used by the
	 *  stuck-state watchdog between ticks). */
	private paintDegraded(parts: string[], tooltip: string | null): void {
		this.aiStateEl.setText(parts.join("\n"));
		this.aiStateEl.setAttribute("title", tooltip ?? "");
		this.aiStateEl.show();
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
		if (!widgets?.progressFill || !widgets?.progressLabel) return;
		this.paintProgress(
			this.panels.get(port)?.progress ?? null,
			widgets.progressFill,
			widgets.progressLabel,
		);
	}

	/**
	 * Refresh one comfy port's cached queue cards (inline labels, running
	 * prompt info, pending rows, cancel enablement, progress bar) against the
	 * latest poll data, and report its running/pending counts as the sort
	 * input for the pure job list (idle instances contribute no cards).
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

		panel.runLabel.setText(p.label);

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

		// pending list (refilled — rows come and go); the card's inline label
		// rides on top of each per-prompt delete row
		panel.pendingIds = pending.flatMap((e) =>
			Array.isArray(e) && typeof e[1] === "string" ? [e[1] as string] : [],
		);
		panel.pendingLabel.setText(p.label);
		panel.pendingMeta.setText(
			`${panel.pendingIds.length} pending`,
		);
		// remove the refilled rows but keep the card's label head
		for (const child of [...panel.pendingWrap.children]) {
			if (child.hasClass?.("arthur-pending-row")) (child as HTMLElement).remove();
		}
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

		this.renderProgress(panel);
		return { running: running.length, pending: pending.length };
	}

	/**
	 * One training job card of the unified queue (stable anchor id
	 * arthur-training-row-<id>): status badge + name + GPUs + step/speed
	 * stats, step progress bar while running, the existing action buttons,
	 * and the chart/log accordion. A multi-GPU ai-toolkit queue set matching
	 * this job's gpu_ids surfaces as a small queue-toggle chip on the card.
	 * Rebuilt per tick — action enablement follows the job status.
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
		const headChildren: (Node | string)[] = [
			el("span", { cls: `arthur-badge ${jobBadgeCls(job.status)}`, text: job.status }),
			el("span", { cls: "arthur-card-title", text: name, attrs: { title: job.name } }),
			el("span", { cls: "arthur-card-meta", text: `GPUs ${job.gpu_ids || "?"}` }),
			el("span", {
				cls: "arthur-card-meta",
				text: `${job.step}/${job.total_steps ?? "?"} · ${job.speed_string || "—"}`,
			}),
		];
		// Multi-GPU ai-toolkit queue set: a small queue-toggle chip on each
		// matching training job card (single-GPU sets live on GPU column
		// headers instead).
		const jobGpus = parseGpuIds(job.gpu_ids);
		if (jobGpus.length > 1 && this.aiDetail.queuesOk === true) {
			const match = this.aiDetail.queues.find(
				(q) => parseGpuIds(q.gpu_ids).join(",") === jobGpus.join(","),
			);
			if (match) headChildren.push(this.queueToggleChip(match));
		}
		card.append(
			el("div", {
				cls: "arthur-card-head",
				children: headChildren,
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

	// ------------------------------------------------------------------
	// service-level controls (service bar) + instance lifecycle (rows)
	// — start/spawn carry the ONLY optimistic surface (pending rows +
	// boot-grace rendering); everything else funnels through run()/toast
	// + pollNow().
	// ------------------------------------------------------------------

	/** The plugin started/spawned an instance — record the boot-grace stamp
	 *  (id + port keys) so the up:false report during ComfyUI boot renders
	 *  'spawning…' instead of 'down'. */
	private recordPluginStart(inst: { id: string; port: number } | null | undefined): void {
		if (!inst) return;
		const now = Date.now();
		if (inst.id) this.pluginStarts.set(`id:${inst.id}`, now);
		if (inst.port) this.pluginStarts.set(`port:${inst.port}`, now);
	}

	/** The plugin's own recent start/spawn stamp for one instance, or null. */
	private pluginBootGrace(inst: AgentInstance): number | null {
		const now = Date.now();
		let best: number | null = null;
		for (const k of [`id:${inst.id}`, inst.port != null ? `port:${inst.port}` : null]) {
			if (!k) continue;
			const ts = this.pluginStarts.get(k);
			if (ts != null && now - ts <= SPAWN_TIMEOUT_MS && (best === null || ts > best)) {
				best = ts;
			}
		}
		return best;
	}

	/**
	 * Insert an optimistic 'spawning…' grid row for a service-bar click —
	 * SYNCHRONOUSLY (called before the request round-trip), then repaint the
	 * grid so the click feedback is immediate. start mode inserts the service's
	 * default instance placeholder; spawn mode a 'new instance' placeholder
	 * (id spawning-<svc>-<seq>) carrying the dropdown's GPU selection.
	 */
	private beginSpawnPending(svc: AgentService, mode: "start" | "spawn", gpusIn: number[]): SpawnPending {
		const now = Date.now();
		const defaultInst = svc.instances[0] ?? null;
		const p: SpawnPending =
			mode === "start"
				? {
					k: `${svc.id}:start`,
					svcId: svc.id,
					mode,
					title: defaultInst?.name ?? defaultInst?.id ?? svc.id,
					gpus: [],
					expectId: defaultInst?.id ?? `${svc.id}-0`,
					expectPort: svc.default_port || defaultInst?.port || null,
					createdAt: now,
					failed: false,
				}
				: {
					k: `spawning-${svc.id}-${++this.spawnSeq}`,
					svcId: svc.id,
					mode,
					title: "new instance",
					gpus: [...gpusIn].sort((a, b) => a - b),
					expectId: null,
					expectPort: null,
					createdAt: now,
					failed: false,
				};
		this.spawnPendings.set(p.k, p);
		// The plugin caused this start — the default-port instance earns its
		// boot grace even before the request response names the real id (spawn
		// mode learns the port from the response, so nothing is stamped yet).
		if (mode === "start" && svc.default_port) {
			this.pluginStarts.set(`port:${svc.default_port}`, now);
		}
		this.renderInstances();
		return p;
	}

	/**
	 * Per-poll resolution of the optimistic spawn pendings: an /api/status
	 * instance matching the pending's expected id (from the request response)
	 * or expected port replaces it; after 45s without a match the pending
	 * flips to the error state and the NEXT successful poll auto-dismisses it.
	 * Also prunes stale boot-grace stamps.
	 */
	private tickSpawnPendings(): void {
		const now = Date.now();
		for (const [k, ts] of this.pluginStarts) {
			if (now - ts > SPAWN_START_PRUNE_MS) this.pluginStarts.delete(k);
		}
		const status = this.agentDetail.status;
		const ok = this.agentDetail.statusOk === true && status !== null;
		for (const p of [...this.spawnPendings.values()]) {
			if (ok) {
				const svc = status!.services.find((s) => s.id === p.svcId);
				const matched = svc?.instances.find(
					(i) =>
						(p.expectId != null && i.id === p.expectId) ||
						(p.expectPort != null && i.port === p.expectPort),
				);
				if (matched) {
					this.spawnPendings.delete(p.k);
					this.recordPluginStart(matched);
					continue;
				}
			}
			if (!p.failed && now - p.createdAt > SPAWN_TIMEOUT_MS) p.failed = true;
			else if (p.failed && ok) this.spawnPendings.delete(p.k); // auto-dismiss next successful poll
		}
	}

	/** Per-service GPU dropdown data (multi-instance services only; null → the
	 *  dropdown stays closed — single-instance services, agent unreachable). */
	private svcGpuMenuData(svcId: string): GpuMenuData | null {
		const status = this.agentDetail.status;
		if (this.agentDetail.statusOk !== true || !status) return null;
		const svc = status.services.find((s) => s.id === svcId);
		if (!svc || !svc.multi_instance) return null;
		const occupants = new Map<number, string[]>();
		for (const inst of svc.instances) {
			for (const g of inst.gpus?.length ? inst.gpus : inst.gpu != null ? [inst.gpu] : []) {
				const list = occupants.get(g) ?? [];
				if (!list.includes(inst.id)) list.push(inst.id);
				occupants.set(g, list);
			}
		}
		return {
			gpus: this.gpuDetail.list.map((g) => ({
				index: g.index,
				name: g.name,
				usedMb: g.mem_used_mb,
				totalMb: g.mem_total_mb,
				util: g.util_percent,
			})),
			occupants,
		};
	}

	/** The persisted spawn GPU selection of a service (default: none). */
	private gpuSelectionFor(svcId: string): number[] {
		const sel = this.plugin.settings.spawnGpuSel?.[svcId];
		return Array.isArray(sel) ? sel.filter((n) => Number.isInteger(n) && n >= 0) : [];
	}

	/** Persist a spawn GPU selection (empty set → back to the default). */
	private setGpuSelection(svcId: string, gpus: number[]): void {
		const settings = this.plugin.settings;
		settings.spawnGpuSel ??= {};
		const sorted = [...new Set(gpus.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
		if (sorted.length > 0) settings.spawnGpuSel[svcId] = sorted;
		else delete settings.spawnGpuSel[svcId];
		void this.plugin.saveSettings();
	}

	/** Inactive service clicked — start the default instance, with an
	 *  optimistic 'spawning…' row until /api/status proves it landed. */
	private async serviceStartAction(svc: AgentService): Promise<void> {
		const agent = this.plugin.clients?.agent;
		if (!agent) return;
		const name = svc.name ?? svc.id;
		const pending = this.beginSpawnPending(svc, "start", []);
		try {
			const res = await agent.serviceStart(svc.id);
			// The response (when it carries the instance) sharpens the match
			// targets and stamps the boot grace.
			if (res.instance) {
				if (res.instance.id) pending.expectId = res.instance.id;
				if (res.instance.port) pending.expectPort = res.instance.port;
				this.recordPluginStart(res.instance);
			}
			toastOk(`start ${name} — done`);
		} catch (err) {
			this.spawnPendings.delete(pending.k);
			toastErr(`start ${name} — ${describeError(err)}`);
		} finally {
			this.renderInstances();
			for (const p of this.pollers()) p.pollNow();
		}
	}

	/** Active service clicked — spawn a new instance with the dropdown's GPU
	 *  selection (empty selection = no body → agent modulo rotation), with an
	 *  optimistic 'spawning…' row until /api/status lists the new instance. */
	private async serviceSpawnAction(svc: AgentService): Promise<void> {
		const agent = this.plugin.clients?.agent;
		if (!agent) return;
		const name = svc.name ?? svc.id;
		const sel = [...this.gpuSelectionFor(svc.id)].sort((a, b) => a - b);
		const selected = sel.length > 0 ? sel : undefined;
		const pending = this.beginSpawnPending(svc, "spawn", sel);
		try {
			const res = await agent.serviceSpawn(svc.id, selected);
			if (res.instance) {
				if (res.instance.id) pending.expectId = res.instance.id;
				if (res.instance.port) pending.expectPort = res.instance.port;
				this.recordPluginStart(res.instance);
			}
			toastOk(
				`Spawned ${name} instance on port ${res.instance?.port ?? "?"}`
					+ (selected ? ` · GPU ${selected.join(", ")}` : ""),
			);
		} catch (err) {
			this.spawnPendings.delete(pending.k);
			toastErr(`spawn ${name} — ${describeError(err)}`);
		} finally {
			this.renderInstances();
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
			const res = await agent.serviceStop(svc.id, force || undefined);
			// v0.5.4: stop-all also FORGETS every non-default instance — surface
			// the dropped ids in the toast so the grid's vanishing rows explain
			// themselves (older agents omit the field).
			const forgotten = res.forgotten?.length ?? 0;
			toastOk(
				`stop ${name} — done`
					+ (forgotten > 0
						? ` · ${forgotten} additional instance${forgotten === 1 ? "" : "s"} forgotten`
						: ""),
			);
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

	/**
	 * Forget a STOPPED instance (grid down-row Remove): POST .../forget drops
	 * it from the agent's registry so it no longer shows in /api/status.
	 * 409 while the instance is still up (the row would be a running row
	 * anyway — the agent is the truth), 404 unknown. Toast + re-poll either
	 * way; never optimistic.
	 */
	private async instanceForget(svcId: string, instId: string): Promise<void> {
		const agent = this.plugin.clients?.agent;
		if (!agent) return;
		await run(this.pollers(), `remove ${instId} from the agent`, () =>
			agent.instanceForget(svcId, instId),
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
		// Device report v0.7.1 (WS churn against dead 8188/8189 after stop-all):
		// a socket may only exist for an up:true agent instance. While
		// /api/status has not answered (or is failing → the settings-fallback
		// 'unmanaged' port list) the view cannot know which ports are alive, so
		// it opens NOTHING — the first answering poll tick attaches sockets to
		// the live instances instead of spinning reconnect loops against dead
		// ports.
		if (this.agentDetail.statusOk !== true) return;
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

	/**
	 * WS sockets exist ONLY for up:true agent instances: with the agent
	 * answering, close + drop every socket whose port is not in the current
	 * up-instance port set — an instance going down or being forgotten kills
	 * its socket at the next poll tick, never leaving a backoff loop against
	 * a dead port (device report v0.7.1). The port-set rebuild in syncSkeleton
	 * already tears the whole socket set down on any port change; this is the
	 * belt-and-braces sweep when the socket map has drifted from the desired
	 * set.
	 */
	private syncWss(): void {
		if (this.agentDetail.statusOk !== true) return;
		const desired = new Set(this.activePorts.map((p) => p.port));
		for (const [port, conn] of [...this.wss]) {
			if (!desired.has(port)) {
				conn.close();
				this.wss.delete(port);
			}
		}
	}

	private wsStateChanged(port: number, state: WsState): void {
		if (!this.isOpened) return;
		// WS state chip lives on the instance grid card (updated in place, no
		// grid rebuild); with no cached chip the next grid repaint shows it.
		const widgets = this.gridRows.get(`run:${port}`);
		if (widgets?.wsChip) this.paintWsChip(widgets.wsChip, state);
		// (re)connect resync: WS open → re-poll queue + progress state (previous
		// behavior of the group header's ws dot — now the grid chip).
		if (state === WsState.Open) void this.refreshData();
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
