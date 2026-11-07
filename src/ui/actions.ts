/**
 * Mutation glue shared by dashboard controls: confirm dialogs, Notice helpers,
 * and run() — the single path every api-writing action goes through
 * (await call → notice → re-poll; never optimistic UI updates).
 */
import { App, Modal, Notice } from "obsidian";

import { ArthurApiError } from "../api/transport";
import { debugLine } from "../debug-log";

/** Success toast (short-lived). */
export function toastOk(message: string): void {
	new Notice(`arthur: ${message}`, 3500);
}

/** Error toast (longer-lived — the text may carry a server message). */
export function toastErr(message: string): void {
	new Notice(`arthur: ${message}`, 8000);
}

/** Human readable one-liner for a failed request (status + server message). */
export function describeError(err: unknown): string {
	if (err instanceof ArthurApiError) {
		return err.status === 0
			? `${err.message} (offline)`
			: `${err.message} (HTTP ${err.status})`;
	}
	if (err instanceof Error) return err.message;
	return String(err);
}

class ConfirmDialog extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.message });

		const buttons = this.contentEl.createEl("div", {
			cls: "arthur-modal-buttons",
		});
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const confirm = buttons.createEl("button", {
			text: "Confirm",
			cls: "mod-warning",
		});
		confirm.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Open a destructive-action confirmation dialog; onConfirm runs only after
 * the user confirms. No state is touched until then.
 */
export function confirmModal(
	app: App,
	title: string,
	message: string,
	onConfirm: () => void,
): void {
	new ConfirmDialog(app, title, message, onConfirm).open();
}

/**
 * Fire a mutating api call, toast the result (with the server's message on
 * failure) and force an immediate re-poll so the UI shows the true server
 * state. Errors never update UI state directly.
 */
export async function run(
	pollers: Array<{ pollNow(): void }>,
	label: string,
	apiCall: () => Promise<unknown>,
): Promise<void> {
	try {
		await apiCall();
		toastOk(`${label} — done`);
	} catch (err) {
		// Debug pane (v0.12.0): mutation failures carry the server's message —
		// copyable instead of only a long-lived toast.
		debugLine(`mutation ${label} failed — ${describeError(err)}`);
		toastErr(`${label} — ${describeError(err)}`);
	} finally {
		for (const poller of pollers) poller.pollNow();
	}
}
