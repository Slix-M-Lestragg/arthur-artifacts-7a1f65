import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

import { ArthurAgentClient } from "./api/agent";
import { AiToolkitClient } from "./api/aitoolkit";
import { ComfyUIClient } from "./api/comfy";
import { obsidianRequester } from "./api/transport";
import { Poller } from "./poller";
import { DETAIL_INTERVAL_MS } from "./util";
import { ArthurDashboardView, VIEW_TYPE_ARTHUR_DASHBOARD } from "./ui/dashboard-view";
import { StatusBarPill, StatusBarState } from "./ui/status-bar";
import { fmtBytes, fmtGigCompact, normalizeHost } from "./util";

// Re-exported for bundle smoke tests (scripts/test-bundle.mjs asserts the
// normalizer directly against the compiled main.js export surface; WsConnection
// is asserted for the close-during-CONNECTING swallow; injectIcon for the
// lucide fallback on unknown service ids). Not used at runtime.
export { normalizeHost };
export { WsConnection, WsState } from "./connection";
export { injectIcon, injectServiceIcon, serviceLabel, SERVICE_META } from "./icons";
export { isWebViewerEnabled, openWebUrl, openUiTooltip, WEBVIEWER_VIEW_TYPE } from "./ui/webviewer";
// Pi service-button flow surface (smoke-tests assert the picker helpers and
// the modal class directly against the compiled main.js export surface). Not
// used at runtime beyond the dashboard view's own imports.
export { PiPickerModal, piDeviceRoot, piMenuSessionLabel } from "./ui/pi-picker";
export type { PiPickerDevice, PiPickerOpts } from "./ui/pi-picker";

/** One server profile — host + which ports the services live on + tokens. */
export interface ServerProfile {
	name: string;
	host: string;
	/** Comma-separated list of ComfyUI instance ports, e.g. "8188,8189". */
	comfyPorts: string;
	aiToolkitPort: number;
	agentPort: number;
	aiToolkitToken: string;
	agentToken: string;
}

export interface ArthurSettings {
	profiles: ServerProfile[];
	/** Live preview ring buffer size per ComfyUI instance (default 4). */
	previewCount: number;
	/** Max metric lines drawn in a job loss chart (default 4). */
	maxChartKeys: number;
	/** One-line console.debug breadcrumb per poll tick (default OFF). */
	debugLogging: boolean;
	/** Instances section collapsed (dashboard title toggle; default expanded). */
	instancesCollapsed: boolean;
	/** Job-queue section collapsed (dashboard title toggle; default expanded). */
	queueCollapsed: boolean;
	/** Per-GPU-column collapse of the Services section's instance grid —
	 *  Record<gpuIndex, boolean> (string keys, JSON-safe): true = that column's
	 *  rows hidden via the column-head chevron. Independent of the whole
	 *  section collapse and of the other columns; default {} = all expanded. */
	gpuCollapsed: Record<string, boolean>;
	/** Per-service GPU selection for service-button spawns — Record<serviceId,
	 *  number[]> of checked GPU indexes (empty/missing = default: single GPU,
	 *  no pinned index → agent's modulo rotation). */
	spawnGpuSel: Record<string, number[]>;
	/** Last pi device a session was spawned on (service-bar pi button prefill;
	 *  empty = no device used yet → the only/first online device is used). */
	lastUsedPiDevice: string;
}

/** Clients built from the active profile — rebuilt when settings change. */
export interface ArthurClients {
	profile: ServerProfile;
	/** Parsed ComfyUI instance ports, same order as `comfy`. */
	comfyPorts: number[];
	/** One ComfyUIClient per entry of comfyPorts. */
	comfy: ComfyUIClient[];
	aitoolkit: AiToolkitClient;
	agent: ArthurAgentClient;
	/** Light cycle (12s, always on): feeds the status bar pill. */
	lightPoller: Poller;
	/** Detail cycle (3s): feeds the dashboard; collectors self-gate on view visibility. */
	detailPoller: Poller;
}

const DEFAULT_PROFILE: ServerProfile = {
	name: "home server",
	host: "192.168.1.100",
	comfyPorts: "8188,8189",
	aiToolkitPort: 8675,
	agentPort: 8766,
	aiToolkitToken: "",
	agentToken: "",
};

const DEFAULT_SETTINGS: ArthurSettings = {
	profiles: [{ ...DEFAULT_PROFILE }],
	previewCount: 4,
	maxChartKeys: 4,
	debugLogging: false,
	instancesCollapsed: false,
	queueCollapsed: false,
	gpuCollapsed: {},
	spawnGpuSel: {},
	lastUsedPiDevice: "",
};

/** Parse a bounded positive int; invalid/missing → fallback. */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Sanitize the per-service spawn-GPU selection map: only finite non-negative
 *  integer lists survive (deduped, sorted); malformed entries drop to absent. */
function sanitizeGpuSel(raw: unknown): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(value)) continue;
		const list = value
			.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
			.filter((n, i, arr) => arr.indexOf(n) === i)
			.sort((a, b) => a - b);
		if (list.length > 0) out[key] = list;
	}
	return out;
}

/**
 * Sanitize the per-GPU-column collapse map: only plain string keys (GPU
 * indexes) with a `true` value survive — JSON-safe, default {} = all expanded.
 * Legacy `piCollapsed` entries (the removed standalone-pi collapse) are
 * intentionally dropped.
 */
function sanitizeGpuCollapsed(raw: unknown): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof key === "string" && key.trim() && value === true) out[key] = true;
	}
	return out;
}

const LIGHT_INTERVAL_MS = 12_000;
/** Debounce window for runtime rebuilds triggered from settings edits. */
const REBUILD_DEBOUNCE_MS = 400;

/** One GPU from /api/gpus (agent v0.5.2) — live per-GPU VRAM/temp/util. */
export interface GpuStat {
	index: number;
	usedMb: number | null;
	totalMb: number | null;
	tempC: number | null;
	utilPercent: number | null;
}

/** Light-cycle snapshot — status bar input, kept for inspection/debugging. */
export interface LightState {
	gpus: Array<{
		port: number;
		gpuIndex: number | null;
		online: boolean | null;
		freeBytes: number | null;
	}>;
	/** Live per-GPU stats from /api/gpus when available. */
	gpuStats: GpuStat[];
	queueDepth: number;
	/** Most advanced RUNNING training job, or null. */
	train: { name: string; step: number; total: number | null } | null;
	agentOnline: boolean | null;
	/** pi active sessions across devices (light cycle; null until probed). */
	piActive: number | null;
	lastUpdated: number | null;
}

class ArthurSettingTab extends PluginSettingTab {
	private plugin: ArthurPlugin;

	constructor(app: App, plugin: ArthurPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h3", { text: "Server profile" });

		// Single-profile for v0.1; grows into a profile list later.
		const profile = this.plugin.settings.profiles[0];

		new Setting(containerEl)
			.setName("Profile name")
			.setDesc("Label for this server.")
			.addText((text) =>
				text
					.setValue(profile.name)
					.onChange(async (value) => {
						profile.name = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Host")
			.setDesc("Hostname or IP of the home server (a scheme like http:// is stripped automatically).")
			.addText((text) =>
				text
					.setValue(profile.host)
					.onChange(async (value) => {
						profile.host = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("ComfyUI ports")
			.setDesc("Comma-separated list of ComfyUI instance ports (e.g. 8188,8189).")
			.addText((text) =>
				text
					.setValue(profile.comfyPorts)
					.onChange(async (value) => {
						profile.comfyPorts = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("ai-toolkit port")
			.setDesc("HTTP port of the ai-toolkit UI (default 8675).")
			.addText((text) =>
				text
					.setValue(String(profile.aiToolkitPort))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (!Number.isNaN(port)) {
							profile.aiToolkitPort = port;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Agent port")
			.setDesc("HTTP port of the arthur-agent companion service (default 8766).")
			.addText((text) =>
				text
					.setValue(String(profile.agentPort))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (!Number.isNaN(port)) {
							profile.agentPort = port;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("ai-toolkit token")
			.setDesc("Bearer token expected by ai-toolkit (AI_TOOLKIT_AUTH); empty = no auth header.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(profile.aiToolkitToken).onChange(async (value) => {
					profile.aiToolkitToken = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Agent token")
			.setDesc("Bearer token expected by the arthur-agent service.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(profile.agentToken).onChange(async (value) => {
					profile.agentToken = value;
					await this.plugin.saveSettings();
				});
			});

		const s = this.plugin.settings;
		containerEl.createEl("h3", { text: "Dashboard display" });
		new Setting(containerEl)
			.setName("Preview strip size")
			.setDesc("Mid-generation live preview thumbnails kept per ComfyUI instance (1–12, default 4).")
			.addText((text) =>
				text.setValue(String(s.previewCount)).onChange(async (value) => {
					s.previewCount = clampInt(value, 4, 1, 12);
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Loss chart keys")
			.setDesc("Maximum metric lines drawn in a training loss chart (1–8, default 4).")
			.addText((text) =>
				text.setValue(String(s.maxChartKeys)).onChange(async (value) => {
					s.maxChartKeys = clampInt(value, 4, 1, 8);
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "Diagnostics" });
		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Log one line per poll tick to the developer console (collector, outcome ok/err/timeout, duration, server host:port). Leave off in normal use.")
			.addToggle((toggle) =>
				toggle.setValue(s.debugLogging).onChange(async (value) => {
					s.debugLogging = value;
					await this.plugin.saveSettings();
				})
			);
	}
}

export default class ArthurPlugin extends Plugin {
	settings: ArthurSettings = DEFAULT_SETTINGS;

	/** API clients + pollers for the active profile; null until load/teardown. */
	clients: ArthurClients | null = null;

	/** Live dashboard view instance, if its leaf is open (set/cleared by the view). */
	dashboardView: ArthurDashboardView | null = null;

	/** Cached comfy clients for dynamically discovered instance ports. */
	private readonly comfyClientCache = new Map<number, ComfyUIClient>();

	/** Parsed comfy instance ports of the active profile ([] until clients exist). */
	get comfyPorts(): number[] {
		return this.clients?.comfyPorts ?? [];
	}

	/** Light-cycle snapshot; fed to the status bar pill each tick. */
	private lightState: LightState = {
		gpus: [],
		gpuStats: [],
		queueDepth: 0,
		train: null,
		agentOnline: null,
		piActive: null,
		lastUpdated: null,
	};

	/** Debounce timer for settings-driven runtime rebuilds. */
	private rebuildTimer: number | null = null;

	/** Status bar pill wrapper; owns the DOM element we created. */
	private statusPill: StatusBarPill | null = null;
	/** The status bar item (removed on unload). */
	private statusBarItem: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Dashboard view factory.
		this.registerView(
			VIEW_TYPE_ARTHUR_DASHBOARD,
			(leaf) => new ArthurDashboardView(leaf, this),
		);

		// Ribbon icon opens the dashboard view.
		this.addRibbonIcon("monitor-cog", "Open Arthur dashboard", () => {
			void this.activateView();
		});

		// Status bar pill — always-on light metrics; click opens the dashboard.
		this.statusBarItem = this.addStatusBarItem();
		this.statusPill = new StatusBarPill(this.statusBarItem, () => {
			void this.activateView();
		});

		// Settings tab.
		this.addSettingTab(new ArthurSettingTab(this.app, this));

		// Clients + pollers (also rebuilt on every relevant settings change).
		this.rebuildRuntime();
	}

	/**
	 * (Re)build the live runtime — API clients + pollers — from the active
	 * profile. Runs at onload and after every relevant settings save, so the
	 * components never need a plugin reload to pick up new values. The old
	 * pollers are stopped first; the dashboard view resyncs its cards + WS
	 * sockets on the refresh this triggers (ports/host may have changed).
	 */
	rebuildRuntime(): void {
		this.clients?.lightPoller.stop();
		this.clients?.detailPoller.stop();
		this.rebuildClients();

		const clients = this.clients;
		if (!clients) return;
		// Debug breadcrumb context: which host:ports this collector talks to.
		const describeHosts = () => {
			const p = this.clients?.profile;
			if (!p?.host) return "";
			return `${p.host} (agent :${p.agentPort} · aitk :${p.aiToolkitPort} · comfy :${p.comfyPorts})`;
		};
		clients.lightPoller.registerCollector(
			"light-summary",
			async () => {
				await this.collectLightData();
			},
			describeHosts,
		);
		clients.detailPoller.registerCollector(
			"dashboard-detail",
			async () => {
				// The view no-ops when closed/hidden (its own visibility gate).
				await this.dashboardView?.refreshData();
			},
			describeHosts,
		);
		clients.lightPoller.start();
		clients.detailPoller.start();
		// Belt-and-braces: registerInterval reaps the timers even if a future
		// edit forgets poller.stop() — stale duplicate ids clear to no-ops.
		const lightId = clients.lightPoller.intervalId;
		const detailId = clients.detailPoller.intervalId;
		if (lightId !== null) this.registerInterval(lightId);
		if (detailId !== null) this.registerInterval(detailId);

		// Immediate paints so the status pill + open dashboard reflect the new
		// profile without waiting a full light (12s) / detail (3s) cycle.
		void this.collectLightData();
		void this.dashboardView?.onRuntimeChanged();
	}

	/** Debounced rebuild — settings text inputs fire onChange per keystroke. */
	private scheduleRuntimeRebuild(): void {
		if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			this.rebuildRuntime();
		}, REBUILD_DEBOUNCE_MS);
	}

	/** Build API clients from the active profile; replaces any previous set. */
	private rebuildClients(): void {
		// Discovered instance ports may be stale now (host/ports changed).
		this.comfyClientCache.clear();
		const raw = this.settings.profiles[0];
		// Snapshot (never hand live settings objects into the runtime — text-field
		// edits would mutate an in-flight profile) with the host normalized so
		// every client URL is built from a clean scheme-free bare host.
		const profile: ServerProfile = { ...raw, host: normalizeHost(raw.host) };
		const comfyPorts = profile.comfyPorts
			.split(",")
			.map((p) => parseInt(p.trim(), 10))
			.filter((p) => Number.isFinite(p) && p > 0);

		const comfy = comfyPorts.map(
			(port) => new ComfyUIClient(profile.host, port, obsidianRequester),
		);

		this.clients = {
			profile,
			comfyPorts,
			comfy,
			aitoolkit: new AiToolkitClient(
				profile.host,
				profile.aiToolkitPort,
				profile.aiToolkitToken || null,
				obsidianRequester,
			),
			agent: new ArthurAgentClient(
				profile.host,
				profile.agentPort,
				profile.agentToken || null,
				obsidianRequester,
			),
			lightPoller: new Poller(LIGHT_INTERVAL_MS),
			detailPoller: new Poller(DETAIL_INTERVAL_MS),
		};
		// Debug breadcrumbs follow the settings toggle at every rebuild.
		this.clients.lightPoller.debugLogging = this.settings.debugLogging;
		this.clients.detailPoller.debugLogging = this.settings.debugLogging;
	}

	/**
	 * Comfy client for a given port: the prebuilt one when the port is in the
	 * settings list, otherwise a cached on-demand client (the agent's
	 * discovered instances can appear/disappear without a settings change).
	 */
	comfyClientFor(port: number): ComfyUIClient | null {
		const clients = this.clients;
		if (!clients || !clients.profile.host) return null;
		const idx = clients.comfyPorts.indexOf(port);
		if (idx >= 0) return clients.comfy[idx] ?? null;
		const cached = this.comfyClientCache.get(port);
		if (cached) return cached;
		const client = new ComfyUIClient(clients.profile.host, port, obsidianRequester);
		this.comfyClientCache.set(port, client);
		return client;
	}

	/**
	 * Light cycle: agent status (best-effort), /api/gpus live GPU stats, then
	 * per-instance system_stats + queue for the comfy ports it discovers (the
	 * settings list is the unreachable fallback), ai-toolkit jobs. Anything
	 * failing just means its field stays null / offline. Paints the status
	 * bar pill. Runs every LIGHT_INTERVAL_MS while the plugin is loaded,
	 * dashboard open or not.
	 */
	private async collectLightData(): Promise<void> {
		const clients = this.clients;
		if (!clients) return;

		const best = async <T>(p: Promise<T>): Promise<T | null> => {
			try {
				return await p;
			} catch {
				return null;
			}
		};

		// /api/gpus (agent v0.5.2) is a degradable read — when it fails the pill
		// falls back to the per-instance system_stats free-bytes view.
		const [agentStatus, aiJobs, gpuResp, piStatus] = await Promise.all([
			best(clients.agent.status()),
			best(clients.aitoolkit.jobs()),
			best(clients.agent.gpus()),
			best(clients.agent.piStatus()),
		]);

		// Comfy ports come from the agent's discovered instances when it
		// answers; the settings comfyPorts list is the unreachable fallback.
		// Dead instances (up:false, port dead) are skipped by the light cycle:
		// probing them only produces timeout chatter, and the dashboard's
		// lifecycle section owns their start button.
		const comfyInstancesAll = agentStatus?.services.find((s) => s.id === "comfyui")?.instances ?? null;
		const comfyInstances = comfyInstancesAll?.filter((i) => i.up === true) ?? null;
		const targets: Array<{ port: number; gpu: number | null }> = comfyInstances
			? comfyInstances.map((i) => ({ port: i.port, gpu: i.gpu }))
			: clients.comfyPorts.map((p) => ({ port: p, gpu: null }));

		const results = await Promise.all(
			targets.map(async (t) => {
				const client = this.comfyClientFor(t.port);
				const stats = client ? await best(client.systemStats()) : null;
				const queue = client ? await best(client.queue()) : null;
				return { port: t.port, gpu: t.gpu, stats, queue };
			}),
		);

		const gpus = results.map((r) => ({
			port: r.port,
			gpuIndex: r.gpu,
			online: r.stats !== null,
			freeBytes: r.stats?.devices?.[0]?.vram_free ?? null,
		}));

		const runningJobs = (aiJobs?.jobs ?? []).filter((j) => j.status === "running");
		let train: LightState["train"] = null;
		for (const job of runningJobs) {
			if (train === null || job.step > train.step) {
				train = { name: job.name, step: job.step, total: job.total_steps };
			}
		}

		this.lightState = {
			gpus,
			gpuStats: (gpuResp?.gpus ?? []).map((g) => ({
				index: g.index,
				usedMb: g.mem_used_mb,
				totalMb: g.mem_total_mb,
				tempC: g.temp_c,
				utilPercent: g.util_percent,
			})),
			queueDepth: results.reduce(
				(acc, r) =>
					acc +
					(r.queue ? (r.queue.queue_running?.length ?? 0) + (r.queue.queue_pending?.length ?? 0) : 0),
				0,
			),
			train,
			agentOnline: agentStatus !== null,
			piActive: piStatus
				? (piStatus.devices ?? []).reduce(
						(acc, d) =>
							acc +
							(typeof d.activeSessions === "number"
								? d.activeSessions
								: (d.sessions ?? []).filter((s) => s.active).length),
						0,
				  )
				: null,
			lastUpdated: Date.now(),
		};

		this.paintStatusBar();
	}

	/** Push the light snapshot into the status bar pill. */
	private paintStatusBar(): void {
		if (!this.statusPill) return;
		const s = this.lightState;
		const state: StatusBarState = {
			profileName: this.clients?.profile.name ?? "arthur",
			host: this.clients?.profile.host ?? "",
			gpus: s.gpus.map((g) => ({
				port: g.port,
				gpuIndex: g.gpuIndex,
				online: g.online,
				freeBytes: g.freeBytes,
			})),
			gpuStats: s.gpuStats,
			queueDepth: s.queueDepth,
			train: s.train ? { step: s.train.step, total: s.train.total } : null,
			piActive: s.piActive,
			lastUpdated: s.lastUpdated,
		};
		this.statusPill.update(state);
	}

	onunload(): void {
		// Drop any pending debounced rebuild.
		if (this.rebuildTimer !== null) {
			window.clearTimeout(this.rebuildTimer);
			this.rebuildTimer = null;
		}

		// Detaching the leaf closes the view → WS sockets + dashboardView ref.
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_ARTHUR_DASHBOARD);
		this.dashboardView = null;

		// Stop poller timers (registerInterval above is the backstop).
		this.clients?.lightPoller.stop();
		this.clients?.detailPoller.stop();

		// Remove the status bar element we created.
		this.statusPill = null;
		this.statusBarItem?.remove();
		this.statusBarItem = null;

		this.clients = null;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ArthurSettings> | null;
		const profile = { ...DEFAULT_PROFILE, ...(data?.profiles?.[0] ?? {}) };
		// Normalize on load too: a host saved by an older version (or by hand in
		// data.json) could carry a scheme/slashes; never let it reach URL building.
		profile.host = normalizeHost(profile.host);
		this.settings = {
			profiles: [profile],
			previewCount: clampInt(data?.previewCount, DEFAULT_SETTINGS.previewCount, 1, 12),
			maxChartKeys: clampInt(data?.maxChartKeys, DEFAULT_SETTINGS.maxChartKeys, 1, 8),
			debugLogging: data?.debugLogging === true,
			instancesCollapsed: data?.instancesCollapsed === true,
			queueCollapsed: data?.queueCollapsed === true,
			gpuCollapsed: sanitizeGpuCollapsed(data?.gpuCollapsed),
			spawnGpuSel: sanitizeGpuSel(data?.spawnGpuSel),
			lastUsedPiDevice:
				typeof data?.lastUsedPiDevice === "string" ? data.lastUsedPiDevice.trim() : "",
		};
	}

	async saveSettings(): Promise<void> {
		// Persist a normalized host: whatever ended up in the field (typed with a
		// scheme, trailing slash, spaces) never reaches disk or URL building.
		this.settings.profiles[0].host = normalizeHost(this.settings.profiles[0].host);
		await this.saveData(this.settings);
		// Every live component (clients, pollers, dashboard, status pill)
		// follows the new profile immediately, debounced across keystrokes.
		this.scheduleRuntimeRebuild();
	}

	/**
	 * Open (or reveal) the dashboard view — canonical Obsidian
	 * registerView/setViewState pattern:
	 *   1. reuse an existing arthur-dashboard leaf (never open duplicates),
	 *   2. otherwise create the view via leaf.setViewState({type}) — Obsidian
	 *      runs the registerView factory, then calls the view's internal
	 *      open(containerEl) → load() + onOpen(),
	 *   3. reveal the leaf in case it sits in a collapsed sidebar.
	 */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_ARTHUR_DASHBOARD);
		let leaf = leaves.length ? leaves[0] : workspace.getRightLeaf(false);
		if (!leaf) leaf = workspace.getLeaf(true);
		await leaf.setViewState({
			type: VIEW_TYPE_ARTHUR_DASHBOARD,
			active: true,
		});
		workspace.revealLeaf(leaf);
	}

	/** For docs/debugging: human summary of the last light tick. */
	describeLightState(): string {
		const s = this.lightState;
		const gpus = s.gpus
			.map(
				(g) =>
					`${g.gpuIndex != null ? `G${g.gpuIndex}` : `P${g.port}`}: ${g.online ? fmtBytes(g.freeBytes) : "down"}`,
			)
			.join(", ");
		const stats = s.gpuStats
			.map(
				(g) =>
					`G${g.index} ${fmtGigCompact(g.usedMb)}/${fmtGigCompact(g.totalMb)}` +
					(g.tempC != null ? ` ${Math.round(g.tempC)}°` : ""),
			)
			.join(", ");
		return `gpus[${gpus}]${stats ? ` stats[${stats}]` : ""} queue=${s.queueDepth} agent=${String(s.agentOnline)}`;
	}
}
