/**
 * Instance picker — shown by the `open-pi-terminal` command when one or more
 * terminal leaves are ALREADY open, so the user can jump to an existing
 * instance or spawn a new one. (When zero terminals are open the command goes
 * straight to the session/dir scanner — `TerminalPickerModal`.) Simpler than
 * the reference RibbonInstanceHub popover but the same spirit: one row per
 * open instance with a state-colored dot + cwd, plus a trailing "+ new…"
 * row that opens the session scanner.
 *
 * The instance list + states are passed in (the caller reads them off the
 * TerminalManager / open views); the picker itself is presentational. Clicking
 * a row fires `onPick(cwd)` (focus that leaf) or `onNew()` (open the scanner).
 */
import { App, Modal } from "obsidian";

import { el, truncate } from "../util";
import { terminalStateClass, type TerminalState } from "./terminal-state";
import { remoteProbeError } from "../settings";
import type { RemoteProfile, RemoteProbe, RemotePiSessionInfo } from "../api/ssh-tmux";

/** One open instance row. */
export interface InstanceRow {
	cwd: string;
	/** Display title (cwd's last segment when none was set). */
	title: string;
	/** Current visual state for the dot color. */
	state: TerminalState;
	kind?: "local" | "remote";
	profileId?: string;
	profileLabel?: string;
	tmuxSession?: string;
}

/** Picker opts. */
export interface InstancePickerOpts {
	/** Open instances (caller gathers them off the manager/views). */
	instances: InstanceRow[];
	/** An existing instance row was clicked — focus its leaf. */
	onPick(cwd: string, instance?: InstanceRow): void;
	/** The "+ new…" row was clicked — open the local/remote target chooser. */
	onNew(): void;
	/** Remote discovery is optional so the legacy local picker stays synchronous. */
	remoteProfiles?: RemoteProfile[];
	getRemoteProbe?(profileId: string): RemoteProbe | null;
	listRemoteSessions?(profile: RemoteProfile): Promise<RemotePiSessionInfo[]>;
	onRemoteAttach?(profile: RemoteProfile, tmuxSession: string): void;
}

export class InstancePickerModal extends Modal {
	private remoteSeq = 0;

	constructor(
		app: App,
		private readonly opts: InstancePickerOpts,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("pi terminal — pick an instance");
		this.contentEl.empty();
		this.contentEl.addClass("arthur-instance-picker");
		const list = this.contentEl.createEl("div", { cls: "arthur-instance-list" });
		for (const inst of this.opts.instances) {
			list.append(this.rowFor(inst));
		}
		const newRow = el("div", {
			cls: "arthur-instance-row arthur-instance-row--new",
			attrs: { role: "button", title: "Choose a local directory or configured remote host" },
		});
		newRow.append(el("span", { cls: "arthur-instance-dot arthur-pi-state-new", text: "+" }));
		newRow.append(el("span", { cls: "arthur-instance-title", text: "new…" }));
		newRow.append(el("span", { cls: "arthur-instance-dir", text: "local or remote" }));
		newRow.addEventListener("click", () => {
			this.opts.onNew();
			this.close();
		});
		list.append(newRow);
		this.buildRemoteSessions();
	}

	private rowFor(inst: InstanceRow): HTMLElement {
		const remote = inst.kind === "remote";
		const row = el("div", {
			cls: `arthur-instance-row${remote ? " arthur-instance-row--remote" : ""}`,
			attrs: {
				"data-terminal-cwd": inst.cwd,
				...(inst.profileId ? { "data-remote-profile": inst.profileId } : {}),
				role: "button",
				title: `Focus the pi terminal in ${truncate(inst.cwd, 96)}`,
			},
		});
		row.append(el("span", {
			cls: `arthur-instance-dot ${terminalStateClass(inst.state)}`,
			text: remote ? "⌁" : "•",
		}));
		row.append(el("span", {
			cls: "arthur-instance-title",
			text: truncate(`${inst.title}${remote && !inst.title.includes("(remote)") ? " (remote)" : ""}`, 48),
		}));
		const dir = remote
			? `${inst.profileLabel ?? inst.profileId ?? "remote"} · ${inst.tmuxSession ?? ""} · ${inst.cwd}`
			: inst.cwd;
		row.append(el("span", { cls: "arthur-instance-dir", text: dir, attrs: { title: dir } }));
		row.addEventListener("click", () => {
			this.opts.onPick(inst.cwd, inst);
			this.close();
		});
		return row;
	}

	/** Local rows paint immediately; every SSH listing then fills its own
	 *  profile group independently, so one slow/dead host never blocks others. */
	private buildRemoteSessions(): void {
		const profiles = this.opts.remoteProfiles ?? [];
		const listRemote = this.opts.listRemoteSessions;
		if (profiles.length === 0 || !listRemote) return;
		const seq = ++this.remoteSeq;
		const section = this.contentEl.createEl("section", { cls: "arthur-remote-sessions" });
		section.createEl("h4", { text: "Remote sessions" });
		for (const profile of profiles) {
			const group = section.createEl("div", {
				cls: "arthur-remote-profile-group",
				attr: { "data-remote-profile": profile.id },
			});
			const head = group.createEl("div", { cls: "arthur-remote-profile-line" });
			head.append(probeDot(this.opts.getRemoteProbe?.(profile.id) ?? null));
			head.append(el("strong", { text: profile.label }));
			const body = group.createEl("div", { cls: "arthur-remote-session-list" });
			body.append(el("div", { cls: "arthur-note arthur-remote-loading", text: "listing tmux sessions…" }));
			void listRemote(profile).then((sessions) => {
				if (seq !== this.remoteSeq) return;
				body.empty();
				const attached = sessions.filter((s) => s.attached).length;
				head.append(el("span", { cls: "arthur-note", text: `${attached} attached` }));
				if (sessions.length === 0) {
					body.append(el("div", { cls: "arthur-note", text: "no tmux sessions" }));
					return;
				}
				for (const session of sessions) {
					const row = el("div", {
						cls: "arthur-instance-row arthur-remote-session-row",
						attrs: {
							role: "button",
							"data-remote-profile": profile.id,
							"data-tmux-session": session.name,
						},
					});
					row.append(
						el("span", { cls: "arthur-pi-remote-flag", text: "⌁" }),
						el("span", { cls: "arthur-instance-title", text: session.name }),
						el("span", {
							cls: "arthur-instance-dir",
							text: `${session.attached ? "attached" : "detached"} · ${session.windows} window${session.windows === 1 ? "" : "s"}`,
						}),
					);
					row.addEventListener("click", () => {
						this.opts.onRemoteAttach?.(profile, session.name);
						this.close();
					});
					body.append(row);
				}
			}).catch((err) => {
				if (seq !== this.remoteSeq) return;
				body.empty();
				body.append(el("div", {
					cls: "arthur-remote-session-error arthur-note",
					text: `${profile.label}: ${err instanceof Error ? err.message : String(err)}`,
				}));
			});
		}
	}

	onClose(): void {
		this.remoteSeq++;
		this.contentEl.empty();
	}
}

function probeDot(probe: RemoteProbe | null): HTMLElement {
	const error = probe ? remoteProbeError(probe) : null;
	return el("span", {
		cls: `arthur-remote-probe-dot${probe ? error ? " arthur-remote-probe-dot--error" : " arthur-remote-probe-dot--ok" : ""}`,
		attrs: { title: probe ? error ?? "remote ready" : "not probed" },
	});
}

export interface NewTerminalTargetOpts {
	profiles: RemoteProfile[];
	getRemoteProbe?(profileId: string): RemoteProbe | null;
	onLocal(): void;
	onRemote(profile: RemoteProfile): void;
}

/** Small NEW-session target chooser; resumable remote tmux sessions stay in
 *  InstancePickerModal's progressive Remote sessions subsection. */
export class NewTerminalTargetModal extends Modal {
	constructor(app: App, private readonly opts: NewTerminalTargetOpts) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("New pi terminal — choose a host");
		this.contentEl.empty();
		this.contentEl.addClass("arthur-instance-picker", "arthur-new-terminal-targets");
		const list = this.contentEl.createEl("div", { cls: "arthur-instance-list" });
		const local = el("div", {
			cls: "arthur-instance-row arthur-instance-row--new arthur-terminal-target-local",
			attrs: { role: "button", "data-terminal-target": "local" },
		});
		local.append(
			el("span", { cls: "arthur-instance-dot arthur-pi-state-new", text: "+" }),
			el("span", { cls: "arthur-instance-title", text: "Local" }),
			el("span", { cls: "arthur-instance-dir", text: "choose a directory on this device" }),
		);
		local.addEventListener("click", () => {
			this.opts.onLocal();
			this.close();
		});
		list.append(local);
		for (const profile of this.opts.profiles) {
			const row = el("div", {
				cls: "arthur-instance-row arthur-instance-row--remote arthur-terminal-target-remote",
				attrs: { role: "button", "data-terminal-target": "remote", "data-remote-profile": profile.id },
			});
			row.append(
				probeDot(this.opts.getRemoteProbe?.(profile.id) ?? null),
				el("span", { cls: "arthur-instance-title", text: `⌁ ${profile.label}` }),
				el("span", { cls: "arthur-instance-dir", text: `${profile.sshTarget} · ${profile.remoteCwd} · ${profile.tmuxSession}` }),
			);
			row.addEventListener("click", () => {
				this.opts.onRemote(profile);
				this.close();
			});
			list.append(row);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
