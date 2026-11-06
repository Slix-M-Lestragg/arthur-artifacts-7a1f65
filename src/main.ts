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
import {
	ArthurDashboardView,
	VIEW_TYPE_ARTHUR_DASHBOARD,
} from "./ui/dashboard-view";
import { StatusBarPill, StatusBarState } from "./ui/status-bar";
import { fmtBytes } from "./util";

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
};

/** Parse a bounded positive int; invalid/missing → fallback. */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const LIGHT_INTERVAL_MS = 12_000;
const DETAIL_INTERVAL_MS = 3_000;

/** Light-cycle snapshot — status bar input, kept for inspection/debugging. */
export interface LightState {
	gpus: Array<{
		port: number;
		gpuIndex: number | null;
		online: boolean | null;
		freeBytes: number | null;
	}>;
	queueDepth: number;
	/** Most advanced RUNNING training job, or null. */
	train: { name: string; step: number; total: number | null } | null;
	agentOnline: boolean | null;
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
			.setDesc("Hostname or IP of the home server.")
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
	}
}

export default class ArthurPlugin extends Plugin {
	settings: ArthurSettings = DEFAULT_SETTINGS;

	/** API clients + pollers for the active profile; null until load/teardown. */
	clients: ArthurClients | null = null;

	/** Live dashboard view instance, if its leaf is open (set/cleared by the view). */
	dashboardView: ArthurDashboardView | null = null;

	/** Parsed comfy instance ports of the active profile ([] until clients exist). */
	get comfyPorts(): number[] {
		return this.clients?.comfyPorts ?? [];
	}

	/** Light-cycle snapshot; fed to the status bar pill each tick. */
	private lightState: LightState = {
		gpus: [],
		queueDepth: 0,
		train: null,
		agentOnline: null,
		lastUpdated: null,
	};

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

		// Clients + pollers.
		this.rebuildClients();
		const clients = this.clients;
		if (clients) {
			clients.lightPoller.registerCollector("light-summary", async () => {
				await this.collectLightData();
			});
			clients.detailPoller.registerCollector("dashboard-detail", async () => {
				// The view no-ops when closed/hidden (its own visibility gate).
				await this.dashboardView?.refreshData();
			});
			clients.lightPoller.start();
			clients.detailPoller.start();
			// Belt-and-braces: registerInterval reaps the timers even if a
			// future edit forgets poller.stop() in onunload.
			const lightId = clients.lightPoller.intervalId;
			const detailId = clients.detailPoller.intervalId;
			if (lightId !== null) this.registerInterval(lightId);
			if (detailId !== null) this.registerInterval(detailId);
		}
	}

	/** Build API clients from the active profile; replaces any previous set. */
	private rebuildClients(): void {
		const profile = this.settings.profiles[0];
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
	}

	/**
	 * Light cycle: per-port system_stats + queue, ai-toolkit jobs, agent
	 * status (best-effort; anything failing just means its field stays null
	 * / offline). Paints the status bar pill. Runs every LIGHT_INTERVAL_MS
	 * while the plugin is loaded, dashboard open or not.
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

		const results = await Promise.all(
			clients.comfy.map(async (client) => ({
				stats: await best(client.systemStats()),
				queue: await best(client.queue()),
			})),
		);
		const [agentStatus, aiJobs] = await Promise.all([
			best(clients.agent.status()),
			best(clients.aitoolkit.jobs()),
		]);

		const gpus = results.map((r, i) => ({
			port: clients.comfyPorts[i],
			gpuIndex:
				agentStatus?.instances.find((v) => v.port === clients.comfyPorts[i])?.gpu ??
				null,
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
			queueDepth: results.reduce(
				(acc, r) =>
					acc +
					(r.queue ? (r.queue.queue_running?.length ?? 0) + (r.queue.queue_pending?.length ?? 0) : 0),
				0,
			),
			train,
			agentOnline: agentStatus !== null,
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
			queueDepth: s.queueDepth,
			train: s.train ? { step: s.train.step, total: s.train.total } : null,
			lastUpdated: s.lastUpdated,
		};
		this.statusPill.update(state);
	}

	onunload(): void {
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

	private async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ArthurSettings> | null;
		this.settings = {
			profiles: [{ ...DEFAULT_PROFILE, ...(data?.profiles?.[0] ?? {}) }],
			previewCount: clampInt(data?.previewCount, DEFAULT_SETTINGS.previewCount, 1, 12),
			maxChartKeys: clampInt(data?.maxChartKeys, DEFAULT_SETTINGS.maxChartKeys, 1, 8),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Open (or reveal) the dashboard view. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_ARTHUR_DASHBOARD)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({
				type: VIEW_TYPE_ARTHUR_DASHBOARD,
				active: true,
			});
		}
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
		return `gpus[${gpus}] queue=${s.queueDepth} agent=${String(s.agentOnline)}`;
	}
}
