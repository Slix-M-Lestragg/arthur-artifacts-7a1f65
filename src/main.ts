import {
	App,
	ItemView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_ARTHUR_DASHBOARD = "arthur-dashboard";
const PLUGIN_VERSION = "0.1.0";

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
};

/** Placeholder dashboard view — real monitoring UI lands in milestone M2. */
class ArthurDashboardView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
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

	async onOpen(): Promise<void> {
		const root = this.contentEl.createEl("div", {
			cls: "arthur-dashboard",
		});
		root.createEl("h2", { text: "Arthur — remote instance manager" });
		root.createEl("p", {
			text: "Live monitoring of ComfyUI instances, generation queue and ai-toolkit training arrives in milestone M2 (see docs/PLAN.md).",
			cls: "arthur-note",
		});
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
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

		// Single-profile scaffold; M2+ grows this into a multi-profile list.
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
			.setDesc("Bearer token expected by ai-toolkit (AI_TOOLKIT_AUTH).")
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
	}
}

export default class ArthurPlugin extends Plugin {
	settings: ArthurSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Ribbon icon opens the dashboard view.
		this.addRibbonIcon("monitor-cog", "Open Arthur dashboard", async () => {
			await this.activateView();
		});

		// Status bar pill — compact metrics arrive in M2; placeholder for now.
		const statusBar = this.addStatusBarItem();
		statusBar.setText(`arthur ${PLUGIN_VERSION}`);

		// Dashboard view factory.
		this.registerView(
			VIEW_TYPE_ARTHUR_DASHBOARD,
			(leaf) => new ArthurDashboardView(leaf)
		);

		// Settings tab.
		this.addSettingTab(new ArthurSettingTab(this.app, this));

		// Nothing periodic is registered yet — no orphan timers on unload.
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_ARTHUR_DASHBOARD);
	}

	private async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ArthurSettings> | null;
		this.settings = {
			profiles: [ { ...DEFAULT_PROFILE, ...(data?.profiles?.[0] ?? {}) } ],
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async activateView(): Promise<void> {
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
}
