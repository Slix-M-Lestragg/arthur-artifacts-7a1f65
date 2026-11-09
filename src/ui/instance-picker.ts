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

/** One open instance row. */
export interface InstanceRow {
	cwd: string;
	/** Display title (cwd's last segment when none was set). */
	title: string;
	/** Current visual state for the dot color. */
	state: TerminalState;
}

/** Picker opts. */
export interface InstancePickerOpts {
	/** Open instances (caller gathers them off the manager/views). */
	instances: InstanceRow[];
	/** An existing instance row was clicked — focus its leaf. */
	onPick(cwd: string): void;
	/** The "+ new…" row was clicked — open the session/dir scanner. */
	onNew(): void;
}

export class InstancePickerModal extends Modal {
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
		// "+ new…" row → open the session scanner.
		const newRow = el("div", {
			cls: "arthur-instance-row arthur-instance-row--new",
			attrs: { role: "button", title: "Open the session/dir picker to start a new terminal" },
		});
		newRow.append(el("span", { cls: "arthur-instance-dot arthur-pi-state-new", text: "+" }));
		newRow.append(
			el("span", { cls: "arthur-instance-title", text: "new…" }),
		);
		newRow.append(
			el("span", { cls: "arthur-instance-dir", text: "open the session picker" }),
		);
		newRow.addEventListener("click", () => {
			this.opts.onNew();
			this.close();
		});
		list.append(newRow);
	}

	private rowFor(inst: InstanceRow): HTMLElement {
		const row = el("div", {
			cls: "arthur-instance-row",
			attrs: {
				"data-terminal-cwd": inst.cwd,
				role: "button",
				title: `Focus the pi terminal in ${truncate(inst.cwd, 96)}`,
			},
		});
		// State-colored dot (CSS colors .arthur-pi-state-<state>).
		row.append(
			el("span", {
				cls: `arthur-instance-dot ${terminalStateClass(inst.state)}`,
				text: "•",
			}),
		);
		row.append(el("span", { cls: "arthur-instance-title", text: truncate(inst.title, 48) }));
		row.append(el("span", { cls: "arthur-instance-dir", text: inst.cwd, attrs: { title: inst.cwd } }));
		row.addEventListener("click", () => {
			this.opts.onPick(inst.cwd);
			this.close();
		});
		return row;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
