/**
 * Ribbon hub — one ribbon icon "pi terminal" with a hover popover listing the
 * OPEN terminal instances (state-colored dot + cwd); click a row to focus its
 * leaf, "+ new" opens the session/dir picker. Simpler than the reference
 * RibbonInstanceHub (no per-instance right-click management menu — our
 * instances are cwd-bound leaves, not a configured instance list), but the
 * same spirit: a single visual hub for every open terminal.
 *
 * The popover is built lazily on first hover and rebuilt each show so it never
 * goes stale vs. the live leaves. State dots read each open view's current
 * visual state (TerminalView.getVisualState). Hides on mouseleave (with a
 * small grace delay) and on any outside click.
 */
import { setIcon, setTooltip } from "obsidian";

import type ArthurPlugin from "../main";
import { el, truncate } from "../util";
import { terminalStateClass, type TerminalState } from "./terminal-state";

const HUB_HIDE_DELAY_MS = 300;
const HUB_GAP_PX = 6;

/**
 * Wire a floating instance hub to the pi-terminal ribbon icon. The ribbon
 * element is the one returned by `addRibbonIcon`; the plugin is registered for
 * cleanup of the popover + the outside-click handler.
 */
export function attachRibbonHub(ribbonEl: HTMLElement, plugin: ArthurPlugin): void {
	let hubEl: HTMLElement | null = null;
	let hideTimeout: number | null = null;

	const clearHideTimer = (): void => {
		if (hideTimeout !== null) {
			window.clearTimeout(hideTimeout);
			hideTimeout = null;
		}
	};

	const hideHub = (): void => {
		hubEl?.removeClass("is-visible");
	};

	const scheduleHide = (): void => {
		clearHideTimer();
		hideTimeout = window.setTimeout(() => {
			hideHub();
			hideTimeout = null;
		}, HUB_HIDE_DELAY_MS);
	};

	const showHub = (): void => {
		clearHideTimer();
		if (!hubEl) {
			hubEl = document.body.createDiv({ cls: "arthur-ribbon-hub" });
			plugin.register(() => hubEl?.remove());
			hubEl.addEventListener("mouseenter", clearHideTimer);
			hubEl.addEventListener("mouseleave", scheduleHide);
			hubEl.addEventListener("click", (evt) => {
				if ((evt.target as HTMLElement).closest(".arthur-ribbon-hub-row")) hideHub();
			});
			plugin.registerDomEvent(document, "click", (evt) => {
				if (hubEl?.hasClass("is-visible") && !hubEl.contains(evt.target as Node) && !ribbonEl.contains(evt.target as Node)) {
					hideHub();
				}
			});
		}
		positionHub(hubEl, ribbonEl);
		rebuildHub(hubEl, plugin);
		hubEl.addClass("is-visible");
	};

	ribbonEl.addEventListener("mouseenter", showHub);
	ribbonEl.addEventListener("mouseleave", scheduleHide);
	plugin.register(() => {
		clearHideTimer();
		hubEl?.remove();
		hubEl = null;
	});
}

function positionHub(hubEl: HTMLElement, anchorEl: HTMLElement): void {
	const rect = anchorEl.getBoundingClientRect();
	hubEl.style.left = `${rect.right + HUB_GAP_PX}px`;
	hubEl.style.top = `${rect.top + rect.height / 2}px`;
}

function rebuildHub(hubEl: HTMLElement, plugin: ArthurPlugin): void {
	hubEl.empty();
	const instances = plugin.terminalManager?.openInstances() ?? [];
	// "+ new" row always first.
	const addRow = hubEl.createDiv({
		cls: "arthur-ribbon-hub-row arthur-ribbon-hub-row--new",
		attr: { "aria-label": "New pi terminal", title: "Open the session/dir picker" },
	});
	setIcon(addRow, "plus");
	addRow.createSpan({ cls: "arthur-ribbon-hub-label", text: "new…" });
	addRow.addEventListener("click", () => {
		plugin.openTerminalPicker();
	});

	if (instances.length === 0) {
		const empty = hubEl.createDiv({ cls: "arthur-ribbon-hub-empty" });
		empty.setText("no pi terminals open");
		return;
	}
	for (const inst of instances) {
		const row = hubEl.createDiv({
			cls: "arthur-ribbon-hub-row",
			attr: { "data-terminal-cwd": inst.cwd, title: truncate(inst.cwd, 96) },
		});
		const dot = row.createSpan({ cls: `arthur-ribbon-hub-dot ${terminalStateClass(inst.state)}` });
		dot.setText("•");
		row.createSpan({ cls: "arthur-ribbon-hub-label", text: truncate(inst.title, 40) });
		row.createSpan({ cls: "arthur-ribbon-hub-dir", text: truncate(inst.cwd, 56) });
		setTooltip(row, inst.cwd, { placement: "top" });
		row.addEventListener("click", () => {
			void plugin.activatePiTerminal({ cwd: inst.cwd, ...(inst.title ? { title: inst.title } : {}) });
		});
	}
}

/** Re-export the state type for callers that build rows themselves. */
export type { TerminalState } from "./terminal-state";
