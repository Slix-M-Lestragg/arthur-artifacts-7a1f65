import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Platform,
	MarkdownView,
	TFile,
	Notice,
} from "obsidian";

import { ArthurAgentClient } from "./api/agent";
import { AiToolkitClient } from "./api/aitoolkit";
import { ComfyUIClient } from "./api/comfy";
import { obsidianRequester } from "./api/transport";
import { Poller } from "./poller";
import { DETAIL_INTERVAL_MS } from "./util";
import { ArthurDashboardView, VIEW_TYPE_ARTHUR_DASHBOARD } from "./ui/dashboard-view";
import { AhpView, VIEW_TYPE_AHP } from "./ui/ahp-view";
import { TerminalView, VIEW_TYPE_PI_TERMINAL } from "./ui/terminal-view";
import { TerminalManager } from "./ui/terminal-manager";
import { TerminalPickerModal, listLocalPiSessions, defaultPiSessionsDir } from "./ui/terminal-picker";
import { InstancePickerModal } from "./ui/instance-picker";
import { attachRibbonHub } from "./ui/ribbon-hub";
import { buildNotePayloadWith, rewriteWikilinks } from "./ui/terminal-note";
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
// Pi session surface (smoke-tests assert the tri-state + device archival
// grouping helpers directly against the compiled main.js export surface).
export { piSessionState, piDeviceSessionGroups, piSessionLabel, piRenderableSession } from "./ui/pi-panel";
export type { PiSessionState, PiDeviceSessionGroups } from "./ui/pi-panel";
// AHP read-only slice (smoke-tests assert the URL normalizer + the view's
// lifecycle against the compiled main.js export surface).
export { VIEW_TYPE_AHP, AhpView } from "./ui/ahp-view";
export { AhpClient, ahpWsUrl, AHP_PROTOCOL_VERSION } from "./api/ahp";
// pi terminal view (local pty backend): registration + lifecycle asserted
// against the compiled main.js export surface.
export { VIEW_TYPE_PI_TERMINAL, TerminalView } from "./ui/terminal-view";
// pi terminal manager: per-cwd leaf routing + pty lifecycle asserted against
// the compiled main.js export surface.
export { TerminalManager } from "./ui/terminal-manager";
// local pi terminal picker (session/dir listing) + helpers asserted against
// the compiled main.js export surface.
export { TerminalPickerModal, fuzzyMatch, listLocalPiSessions, listSessionFilesForCwd, defaultPiSessionsDir } from "./ui/terminal-picker";
export type { LocalPiSession, SessionFileInfo } from "./ui/terminal-picker";
// local pty spawn wrapper (smoke asserts the spawn args/factory contract +
// the enriched-PATH builder).
export { spawnPi, resolvePtyModulePath, buildSpawnEnv } from "./api/local-pty";
export type { LocalPty, PtySpawnFn, SpawnPiOpts, SpawnEnvDeps } from "./api/local-pty";
// pi terminal visual state + heuristics (smoke asserts transitions + classes).
export { terminalStateClass, computeActivityState, detectAwaitingInput, questionStillLive, ALL_TERMINAL_STATES } from "./ui/terminal-state";
export type { TerminalState, ActivityInputs } from "./ui/terminal-state";
// pi terminal theme-follow builder (smoke asserts the var → ITheme mapping).
export { buildXtermTheme, readObsidianThemeVars, resolveThemeVars, FALLBACK_THEME_VARS } from "./ui/terminal-theme";
export type { ObsidianThemeVars } from "./ui/terminal-theme";
// send-note payload + wikilink rewrite (smoke asserts the byte shape).
export { buildNotePayload, buildNotePayloadWith, rewriteWikilinks } from "./ui/terminal-note";
export type { LinkResolver } from "./ui/terminal-note";
// instance picker (open-instances + new) — asserted against the export surface.
export { InstancePickerModal } from "./ui/instance-picker";
export type { InstanceRow, InstancePickerOpts } from "./ui/instance-picker";
// ribbon hub — attached in onload.
export { attachRibbonHub } from "./ui/ribbon-hub";

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
	/** ai-toolkit integration toggle (default ON). OFF = the user
	 *  intentionally runs this service only when needed: NO aitoolkit
	 *  requests anywhere (collectors skip, nothing in the banner/debug
	 *  pane), the service-bar pill renders a 'disabled' state, and training
	 *  cards/queue toggles vanish. ON-but-unreachable keeps the degraded
	 *  single-line report. */
	aiToolkitEnabled: boolean;
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
	/** 'General' sub-container within the Instances section collapsed (default
	 *  expanded) — the cross-device pi sessions list. */
	generalCollapsed: boolean;
	/** 'GPUs' sub-container within the Instances section collapsed (default
	 *  expanded) — the GPU grid (+ per-GPU-column toggles remain independent). */
	gpusCollapsed: boolean;
	/** 'Debug' log pane collapsed (default COLLAPSED). */
	debugCollapsed: boolean;
	/** Per-GPU-column collapse of the Services section's instance grid —
	 *  Record<gpuIndex, boolean> (string keys, JSON-safe): true = that column's
	 *  rows hidden by clicking the column head. Independent of the whole
	 *  section collapse and of the other columns; default {} = all expanded. */
	gpuCollapsed: Record<string, boolean>;
	/** Per-service GPU selection for service-button spawns — Record<serviceId,
	 *  number[]> of checked GPU indexes (empty/missing = default: single GPU,
	 *  no pinned index → agent's modulo rotation). */
	spawnGpuSel: Record<string, number[]>;
	/** Last pi device a session was spawned on (service-bar pi button prefill;
	 *  empty = no device used yet → the only/first online device is used). */
	lastUsedPiDevice: string;
	/** The device-session archives group inside a device's 'General' list is
	 *  collapsed (default true). One persisted bool for the whole group —
	 *  mirrors the subagent archives pattern. */
	piArchivesCollapsed: boolean;
	/** AHP broker (pi-ahp-server, protocol 0.3.0) WebSocket endpoint as
	 *  host[:port] — no scheme (ws:// is added by the client). Default points
	 *  at the canonical 0.3.0 broker on ulysse (tailscale). The connection is
	 *  LAZY: opened only by the AHP view's Refresh (a user action), never on
	 *  plugin load. */
	ahpEndpoint: string;
	/** AHP broker shared token — sent ONLY as initialize.params.token over the
	 *  WS (never a URL/query/header, never logged). Plaintext in data.json —
	 *  an existing, documented reality (PI-AHP-INTEGRATION-PLAN §6). */
	ahpToken: string;
	/** AHP interactive controls (create/prompt/pause/resume/retry/dispose in
	 *  the pi-sessions view). DEFAULT OFF — read-only unless the user opts in.
	 *  Even when on, a connection only gets controls if the broker assigned it
	 *  the controller role (the client's live canControl), never for
	 *  roles[]/anonymous connections. Opting in assumes a token that grants
	 *  control, which is stored PLAINTEXT in data.json like the read token. */
	ahpEnableControl: boolean;
	/** Pi executable used to spawn local pi terminals (the local-pty backend).
	 *  Default `pi` — resolved from the machine PATH at runtime. Desktop-only;
	 *  the native pty module resolves from the plugin dir's node_modules. */
	piExecutable: string;
	/** xterm font family for new pi terminals (default '' = xterm's built-in
	 *  monospace stack). Applies to NEW terminals only. */
	piTerminalFontFamily: string;
	/** xterm font size for new pi terminals (default 13). Applies to NEW
	 *  terminals only. */
	piTerminalFontSize: number;
	/** xterm scrollback lines for new pi terminals (default 5000). Applies to
	 *  NEW terminals only. */
	piTerminalScrollback: number;
	/** Restore open terminal leaves' sessions on plugin/Obsidian restart
	 *  (default true): saved leaves re-attach and respawn with their saved
	 *  `--session <file>` (or `-c` when none was saved). */
	piTerminalRestoreOnRestart: boolean;
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
	aiToolkitEnabled: true,
};

const DEFAULT_SETTINGS: ArthurSettings = {
	profiles: [{ ...DEFAULT_PROFILE }],
	previewCount: 4,
	maxChartKeys: 4,
	debugLogging: false,
	instancesCollapsed: false,
	queueCollapsed: false,
	generalCollapsed: false,
	gpusCollapsed: false,
	debugCollapsed: true,
	gpuCollapsed: {},
	spawnGpuSel: {},
	lastUsedPiDevice: "",
	piArchivesCollapsed: true,
	ahpEndpoint: "100.75.249.5:4500",
	ahpToken: "",
	ahpEnableControl: false,
	piExecutable: "pi",
	piTerminalFontFamily: "",
	piTerminalFontSize: 13,
	piTerminalScrollback: 5000,
	piTerminalRestoreOnRestart: true,
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
			.setName("ai-toolkit integration")
			.setDesc("Poll the ai-toolkit UI (jobs/queues/stats). Turn OFF while the service is intentionally stopped — the dashboard then makes zero ai-toolkit requests (no error lines); training cards + GPU queue toggles are hidden. Leave on for the degraded single-line report when it is merely unreachable.")
			.addToggle((toggle) =>
				toggle
					.setValue(profile.aiToolkitEnabled !== false)
					.onChange(async (value) => {
						profile.aiToolkitEnabled = value;
						await this.plugin.saveSettings();
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

		const settings = this.plugin.settings;
		containerEl.createEl("h3", { text: "AHP broker (pi sessions)" });
		new Setting(containerEl)
			.setName("AHP endpoint")
			.setDesc("WebSocket endpoint of the AHP broker (pi-ahp-server, protocol 0.3.0) as host:port — e.g. 100.75.249.5:4500. The connection opens only from the pi-sessions view's Refresh button (never on plugin load).")
			.addText((text) =>
				text
					.setValue(settings.ahpEndpoint)
					.onChange(async (value) => {
						settings.ahpEndpoint = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("AHP token")
			.setDesc("Shared broker token, sent ONLY inside the WS initialize handshake (never a URL/HTTP header, never logged). Leave empty when the broker runs without a token.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(settings.ahpToken).onChange(async (value) => {
					settings.ahpToken = value;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("AHP session controls")
			.setDesc(
				"WARNING: Controls (create / prompt / pause / resume / retry / dispose) in the pi-sessions view. Default OFF = read-only. When on, controls still appear ONLY if the negotiated connection holds the broker's controller role (canControl); anonymous connections never get them. Prompts act on real pi sessions, disposal stops a session irreversibly, and the enabling broker token is stored PLAINTEXT in this vault's data.json.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.ahpEnableControl).onChange(async (value) => {
					settings.ahpEnableControl = value;
					await this.plugin.saveSettings();
				}),
		);

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

		containerEl.createEl("h3", { text: "Pi terminal" });
		new Setting(containerEl)
			.setName("pi executable")
			.setDesc("Command used to spawn local pi terminals (the local-pty backend runs this with the chosen working directory; `pi -c` resumes the most recent session in that cwd, `pi --session <file>` resumes a picked session). Default `pi` — must be on the machine's PATH where the plugin runs (desktop only).")
			.addText((text) =>
				text.setValue(s.piExecutable).onChange(async (value) => {
					s.piExecutable = (value ?? "").trim() || "pi";
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Terminal font family")
			.setDesc("xterm font-family for NEW pi terminals (empty = xterm's built-in monospace stack). Already-open terminals keep their current font.")
			.addText((text) =>
				text.setValue(s.piTerminalFontFamily).onChange(async (value) => {
					s.piTerminalFontFamily = value ?? "";
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Terminal font size")
			.setDesc("xterm font size for NEW pi terminals (6–72, default 13). Already-open terminals keep their current size.")
			.addText((text) =>
				text.setValue(String(s.piTerminalFontSize)).onChange(async (value) => {
					s.piTerminalFontSize = clampInt(value, 13, 6, 72);
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Terminal scrollback")
			.setDesc("xterm scrollback lines for NEW pi terminals (0–100000, default 5000). Already-open terminals keep their current scrollback.")
			.addText((text) =>
				text.setValue(String(s.piTerminalScrollback)).onChange(async (value) => {
					s.piTerminalScrollback = clampInt(value, 5000, 0, 100000);
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Restore terminals on restart")
			.setDesc("Reopen the pi terminal leaves that were open when Obsidian last quit, respawning each with its saved `--session <file>` (or `-c` when none was saved). Default on.")
			.addToggle((toggle) =>
				toggle.setValue(s.piTerminalRestoreOnRestart).onChange(async (value) => {
					s.piTerminalRestoreOnRestart = value;
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

	/** Pi terminal manager: routes one terminal leaf per cwd (local pty
	 *  backend — each terminal owns its own pty, no shared socket). Created in
	 *  onload, torn down in onunload; null only around the unload boundary. */
	terminalManager: TerminalManager | null = null;

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

		// Pi terminal manager (T3): owns the shared AHP WS client + multi-leaf
		// routing. Created BEFORE registerView/rebuildRuntime so the view can
		// reach it at attach time and rebuildRuntime's settings-change rebuild
		// finds it.
		this.terminalManager = new TerminalManager(this);

		// Dashboard view factory.
		this.registerView(
			VIEW_TYPE_ARTHUR_DASHBOARD,
			(leaf) => new ArthurDashboardView(leaf, this),
		);

		// AHP read-only view factory + open command (same registerView pattern;
		// the WS client inside is lazy and only connects on the view's Refresh).
		this.registerView(VIEW_TYPE_AHP, (leaf) => new AhpView(leaf, this));
		this.addCommand({
			id: "open-ahp-sessions",
			name: "Open pi sessions (AHP)",
			callback: () => {
				void this.activateAhpView();
			},
		});

		// pi terminal view factory + open command (local pty backend): the leaf
		// carries a target cwd via view state (openTerminal/activatePiTerminal);
		// the bare command opens the local session/dir picker, and a picked cwd
		// routes through the manager into a bound leaf. Desktop-only — hidden on
		// mobile (the local pty + Node fs scan cannot run there).
		this.registerView(VIEW_TYPE_PI_TERMINAL, (leaf) => new TerminalView(leaf, this));
		this.addCommand({
			id: "open-pi-terminal",
			name: "Open pi terminal",
			callback: () => {
				this.openPiTerminalCommand();
			},
		});

		// Send the active note (or just its selection) into the most-recently-
		// focused pi terminal as a prompt. editorCallback fires only in a markdown
		// editor; a Notice tells the user to open a terminal first when none is.
		this.addCommand({
			id: "send-active-note",
			name: "Send active note to pi terminal",
			editorCallback: (editor, ctx) => this.sendActiveNoteToTerminal(editor, ctx),
		});
		this.addCommand({
			id: "send-selection",
			name: "Send selection to pi terminal",
			editorCallback: (editor) => this.sendSelectionToTerminal(editor),
		});

		// Ribbon icon opens the dashboard view.
		this.addRibbonIcon("monitor-cog", "Open Arthur dashboard", () => {
			void this.activateView();
		});

		// Ribbon hub: one "pi terminal" icon with a hover popover listing the
		// open instances (state-colored dot + cwd); click a row to focus its
		// leaf, "+ new" opens the session/dir picker. Desktop-only.
		if (!Platform.isMobile) {
			const piRibbon = this.addRibbonIcon("terminal-square", "pi terminal", () => {
				this.openPiTerminalCommand();
			});
			attachRibbonHub(piRibbon, this);
		}

		// Theme-follow: re-apply the Obsidian-derived xterm theme to every open
		// terminal when the user switches vault theme (CSS vars change).
		this.registerEvent(this.app.workspace.on("css-change", () => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL)) {
				const view = leaf.view;
				if (view instanceof TerminalView) view.applyTheme();
			}
		}));

		// Restore-on-restart: Obsidian reopens saved terminal leaves itself; a
		// leaf that wasn't layout-ready at registerView time still carries its
		// view state, so on layout-ready we re-attach any cwd-bound terminal
		// leaves whose pty never spawned (the lazy attach path no-ops when one
		// already exists). Skipped entirely when the user opted out.
		if (this.settings.piTerminalRestoreOnRestart) {
			this.app.workspace.onLayoutReady(() => this.restoreTerminalLeaves());
		}

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
			// ai-toolkit integration OFF → NO request at all (null keeps the
			// training pill segment empty; the service is user-disabled, never
			// an error state).
			this.aiToolkitEnabled() ? best(clients.aitoolkit.jobs()) : Promise.resolve(null),
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

	/** The profile's ai-toolkit integration toggle (default ON; a legacy saved
	 *  profile without the key still counts as ON). */
	private aiToolkitEnabled(): boolean {
		return this.clients?.profile.aiToolkitEnabled !== false;
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

		// Detach the AHP view leaves too → AhpView.onClose closes its WS client
		// (teardown incl. the fire-and-forget unsubscribe notification).
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_AHP);
		// Terminal leaves → TerminalView.onClose detaches the terminal channel
		// (unsubscribe + watermark drop) and disposes xterm; the shared client is
		// NOT closed by the view (the manager owns it). Close all leaves first so
		// each adapter sends its channel unsubscribe on the live socket, THEN
		// close the shared client.
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PI_TERMINAL);
		this.terminalManager?.closeAll();
		this.terminalManager = null;

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
		// The ai-toolkit toggle defaults to ON — a legacy profile without the
		// key must never read as user-disabled.
		profile.aiToolkitEnabled = profile.aiToolkitEnabled !== false;
		this.settings = {
			profiles: [profile],
			previewCount: clampInt(data?.previewCount, DEFAULT_SETTINGS.previewCount, 1, 12),
			maxChartKeys: clampInt(data?.maxChartKeys, DEFAULT_SETTINGS.maxChartKeys, 1, 8),
			debugLogging: data?.debugLogging === true,
			instancesCollapsed: data?.instancesCollapsed === true,
			queueCollapsed: data?.queueCollapsed === true,
			generalCollapsed: data?.generalCollapsed === true,
			gpusCollapsed: data?.gpusCollapsed === true,
			debugCollapsed: data?.debugCollapsed !== false,
			gpuCollapsed: sanitizeGpuCollapsed(data?.gpuCollapsed),
			spawnGpuSel: sanitizeGpuSel(data?.spawnGpuSel),
			lastUsedPiDevice:
				typeof data?.lastUsedPiDevice === "string" ? data.lastUsedPiDevice.trim() : "",
			piArchivesCollapsed: data?.piArchivesCollapsed !== false,
			ahpEndpoint:
				typeof data?.ahpEndpoint === "string" && data.ahpEndpoint.trim()
					? data.ahpEndpoint.trim()
					: DEFAULT_SETTINGS.ahpEndpoint,
			ahpToken: typeof data?.ahpToken === "string" ? data.ahpToken : "",
			// Off unless explicitly true — legacy data.json without the key stays
			// read-only.
			ahpEnableControl: data?.ahpEnableControl === true,
			piExecutable:
				typeof data?.piExecutable === "string" && data.piExecutable.trim()
					? data.piExecutable.trim()
					: DEFAULT_SETTINGS.piExecutable,
			piTerminalFontFamily:
				typeof data?.piTerminalFontFamily === "string" ? data.piTerminalFontFamily : DEFAULT_SETTINGS.piTerminalFontFamily,
			piTerminalFontSize: clampInt(data?.piTerminalFontSize, DEFAULT_SETTINGS.piTerminalFontSize, 6, 72),
			piTerminalScrollback: clampInt(data?.piTerminalScrollback, DEFAULT_SETTINGS.piTerminalScrollback, 0, 100000),
			piTerminalRestoreOnRestart: data?.piTerminalRestoreOnRestart !== false,
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

	/**
	 * Open (or reveal) the AHP view — the same registerView/right-leaf pattern
	 * as activateView(): reuse an existing leaf, else the right leaf (fallback
	 * getLeaf(true)), setViewState → registerView factory → onOpen(), reveal.
	 */
	async activateAhpView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_AHP);
		let leaf = leaves.length ? leaves[0] : workspace.getRightLeaf(false);
		if (!leaf) leaf = workspace.getLeaf(true);
		await leaf.setViewState({
			type: VIEW_TYPE_AHP,
			active: true,
		});
		workspace.revealLeaf(leaf);
	}

	/**
	 * Open (or reveal) the pi terminal leaf for a working directory. Routed
	 * through the TerminalManager (local pty backend): a leaf already bound to
	 * the given cwd is focused, else a new main-area leaf is created and the
	 * view spawns a local `pi` pty in that cwd. `state` carries `{cwd, title?}`
	 * through the leaf's view state; with no cwd (the bare command path) the
	 * view renders its 'no working directory' state line — the picker fills it.
	 */
	async activatePiTerminal(state?: Record<string, string>): Promise<void> {
		if (!this.terminalManager) return;
		const cwd = typeof state?.cwd === "string" ? state.cwd : undefined;
		const title = typeof state?.title === "string" ? state.title : undefined;
		const fresh = state?.fresh != null && String(state.fresh) === "true";
		const sessionFile = typeof state?.sessionFile === "string" && state.sessionFile.trim() ? state.sessionFile.trim() : undefined;
		await this.terminalManager.openTerminal(cwd, {
			...(title ? { title } : {}),
			...(fresh ? { fresh: true } : {}),
			...(sessionFile ? { sessionFile } : {}),
		});
	}

	/**
	 * Open the local pi terminal picker — the no-cwd entry point of the 'Open
	 * pi terminal' command and the pi-panel opts-callback. Lists local pi
	 * sessions by scanning `~/.pi/agent/sessions/` (dir names encode cwd; the
	 * most-recent session file mtime per cwd), plus a 'New terminal in vault
	 * root' action and a cwd input row. Picking a row routes through
	 * `activatePiTerminal` → `TerminalManager.openTerminal` (re-open of an
	 * already-open cwd focuses its leaf). Desktop-only — a no-op on mobile
	 * (the local pty + Node fs scan cannot run there).
	 */
	openTerminalPicker(): void {
		if (Platform.isMobile) return; // local pty + Node fs scan are desktop-only
		const vaultRoot = (this.app.vault?.adapter as { getBasePath?: () => string } | null)?.getBasePath?.() ?? "";
		const modal = new TerminalPickerModal(this.app, {
			vaultRootCwd: vaultRoot,
			loadSessions: () =>
				Promise.resolve(listLocalPiSessions(defaultPiSessionsDir())),
			onPick: (cwd, title, sessionFile) => {
				void this.activatePiTerminal({ cwd, ...(title ? { title } : {}), ...(sessionFile ? { sessionFile } : {}) });
			},
		});
		modal.open();
	}

	/**
	 * The `open-pi-terminal` command: when one or more terminals are already
	 * open, show the instance picker (jump to an existing instance or spawn a
	 * new one via the session/dir scanner); when none are open, go straight to
	 * the session/dir scanner. Desktop-only — a no-op on mobile.
	 */
	openPiTerminalCommand(): void {
		if (Platform.isMobile) return;
		const open = this.terminalManager?.openInstances() ?? [];
		if (open.length === 0) {
			this.openTerminalPicker();
			return;
		}
		const modal = new InstancePickerModal(this.app, {
			instances: open,
			onPick: (cwd) => {
				void this.activatePiTerminal({ cwd });
			},
			onNew: () => {
				this.openTerminalPicker();
			},
		});
		modal.open();
	}

	/**
	 * `send-active-note`: write the active note's full body into the most-
	 * recently-focused pi terminal's pty as a prompt — title + absolute vault
	 * path header, then the content with `[[wikilinks]]` rewritten to absolute
	 * paths, fenced in `---`, trailing `\r`. A Notice tells the user to open a
	 * terminal first when none is focused. Desktop-only; editorCallback only
	 * fires in a markdown editor.
	 */
	sendActiveNoteToTerminal(editor: import("obsidian").Editor, ctx: { file?: TFile | null }): void {
		if (Platform.isMobile) return;
		const file = ctx.file ?? this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice("Open a note first.", 3000);
			return;
		}
		const view = this.terminalManager?.mostRecentlyFocusedView();
		if (!view) {
			new Notice("Open a pi terminal first (Open pi terminal command).", 4000);
			return;
		}
		const name = file.basename || file.name;
		const absPath = this.noteAbsolutePath(file);
		const content = editor.getValue();
		const payload = buildNotePayloadWith(name, absPath, content, (target) => this.resolveWikilinkTarget(target, file));
		view.writeToPty(payload);
		view.focusTerminal();
	}

	/**
	 * `send-selection`: write just the current editor selection (wikilinks
	 * rewritten to absolute paths) + `\r` into the most-recently-focused pi
	 * terminal. No header — it's a fragment, not a whole note. Same Notice
	 * guard when no terminal is focused.
	 */
	sendSelectionToTerminal(editor: import("obsidian").Editor): void {
		if (Platform.isMobile) return;
		const view = this.terminalManager?.mostRecentlyFocusedView();
		if (!view) {
			new Notice("Open a pi terminal first (Open pi terminal command).", 4000);
			return;
		}
		const sel = editor.getSelection();
		if (!sel) {
			new Notice("Select some text first.", 3000);
			return;
		}
		const file = this.app.workspace.getActiveFile();
		const payload = rewriteWikilinks(sel, (target) =>
			file instanceof TFile ? this.resolveWikilinkTarget(target, file) : null,
		) + "\r";
		view.writeToPty(payload);
		view.focusTerminal();
	}

	/** Absolute filesystem path of a vault note (vault root + file path). */
	private noteAbsolutePath(file: TFile): string {
		const base = (this.app.vault?.adapter as { getBasePath?: () => string } | null)?.getBasePath?.() ?? "";
		return [base.replace(/[\/]+$/, ""), file.path].filter(Boolean).join("/");
	}

	/** Resolve a wikilink target to its absolute vault path via the metadata
	 *  cache (handles aliases + case); null when unresolved. */
	private resolveWikilinkTarget(target: string, source: TFile): string | null {
		const dest = this.app.metadataCache.getFirstLinkpathDest?.(target, source.path);
		if (!(dest instanceof TFile)) return null;
		return this.noteAbsolutePath(dest);
	}

	/** Restore-on-restart: re-attach any cwd-bound terminal leaves whose pty
	 *  never spawned (Obsidian reopens the leaves itself; a leaf that wasn't
	 *  layout-ready at registerView time still carries its saved view state,
	 *  including the `--session <file>` to resume). Idempotent — the lazy
	 *  attach path no-ops when a pty already exists. */
	private restoreTerminalLeaves(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.boundCwd) {
				// Trigger a re-attach by re-applying the leaf's own view state — the
				// view's setState is idempotent (same cwd/sessionFile → maybeAttach).
				void leaf.setViewState?.({ type: VIEW_TYPE_PI_TERMINAL, active: true, state: view.getState() });
			}
		}
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
